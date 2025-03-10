import { $Enums } from "@prisma/client";
import { Sema } from "async-sema";
import { prisma } from '@/utils/db';
import { BlockfrostProvider, Data, MeshWallet, SLOT_CONFIG_NETWORK, Transaction, mBool, unixTimeToEnclosingSlot } from "@meshsdk/core";
import { decrypt } from "@/utils/encryption";
import { logger } from "@/utils/logger";
import * as cbor from "cbor";
import { getPaymentScriptFromNetworkHandlerV1 } from "@/utils/contractResolver";

const updateMutex = new Sema(1);

export async function submitResultV1() {

    //const maxBatchSize = 10;

    const acquiredMutex = await updateMutex.tryAcquire();
    //if we are already performing an update, we wait for it to finish and return
    if (!acquiredMutex)
        return await updateMutex.acquire();

    try {
        const networkChecksWithWalletLocked = await prisma.$transaction(async (prisma) => {
            const networkChecks = await prisma.networkHandler.findMany({
                where: {
                    paymentType: "WEB3_CARDANO_V1",
                }, include: {
                    PaymentRequests: {
                        where: {
                            //the smart contract requires the result hash to be provided before the result time
                            submitResultTime: {
                                lte: Date.now() - 1000 * 60 * 1 //remove 1 minute for block time
                            }
                            , status: { in: ["PaymentConfirmed", "RefundRequested"] },
                            resultHash: { not: null },
                            errorType: null,
                            SmartContractWallet: { PendingTransaction: null }
                        },
                        include: { BuyerWallet: true, SmartContractWallet: { include: { WalletSecret: true } } }
                    },
                    AdminWallets: true,
                    FeeReceiverNetworkWallet: true,
                    CollectionWallet: true
                }
            })
            const sellingWalletIds = networkChecks.map(x => x.PaymentRequests).flat().map(x => x.SmartContractWallet?.id);
            for (const sellingWalletId of sellingWalletIds) {
                await prisma.sellingWallet.update({
                    where: { id: sellingWalletId },
                    data: { PendingTransaction: { create: { hash: null } } }
                })
            }
            return networkChecks;
        }, { isolationLevel: "Serializable" });
        await Promise.allSettled(networkChecksWithWalletLocked.map(async (networkCheck) => {

            if (networkCheck.PaymentRequests.length == 0 || networkCheck.CollectionWallet == null)
                return;

            const network = networkCheck.network == "MAINNET" ? "mainnet" : networkCheck.network == "PREPROD" ? "preprod" : null;
            if (!network)
                throw new Error("Invalid network")

            const networkId = networkCheck.network == "MAINNET" ? 0 : networkCheck.network == "PREPROD" ? 1 : null;
            if (!networkId)
                throw new Error("Invalid network")

            const blockchainProvider = new BlockfrostProvider(networkCheck.rpcProviderApiKey, undefined);


            const paymentRequests = networkCheck.PaymentRequests;

            if (paymentRequests.length == 0)
                return;
            //we can only allow one transaction per wallet
            const deDuplicatedRequests: ({
                BuyerWallet: { id: string; createdAt: Date; updatedAt: Date; walletVkey: string; networkHandlerId: string; note: string | null; } | null;
                SmartContractWallet: ({
                    WalletSecret: { id: string; createdAt: Date; updatedAt: Date; secret: string; };
                } & {
                    id: string; walletAddress: string;
                    createdAt: Date; updatedAt: Date;
                    walletVkey: string; walletSecretId: string; pendingTransactionId: string | null;
                    networkHandlerId: string; note: string | null;
                }) | null;
            } & { id: string; createdAt: Date; updatedAt: Date; lastCheckedAt: Date | null; status: $Enums.PaymentRequestStatus; errorType: $Enums.PaymentRequestErrorType | null; networkHandlerId: string; smartContractWalletId: string | null; buyerWalletId: string | null; identifier: string; resultHash: string | null; submitResultTime: bigint; unlockTime: bigint; refundTime: bigint; utxo: string | null; txHash: string | null; potentialTxHash: string | null; errorRetries: number; errorNote: string | null; errorRequiresManualReview: boolean | null; })[] = []
            for (const request of paymentRequests) {
                if (request.smartContractWalletId == null)
                    continue;
                if (deDuplicatedRequests.some(r => r.smartContractWalletId == request.smartContractWalletId))
                    continue;

                deDuplicatedRequests.push(request);
            }

            await Promise.allSettled(deDuplicatedRequests.map(async (request) => {
                try {
                    const sellingWallet = request.SmartContractWallet!;
                    const encryptedSecret = sellingWallet.WalletSecret.secret;

                    const wallet = new MeshWallet({
                        networkId: 0,
                        fetcher: blockchainProvider,
                        submitter: blockchainProvider,
                        key: {
                            type: 'mnemonic',
                            words: decrypt(encryptedSecret).split(" "),
                        },
                    });

                    const address = (await wallet.getUnusedAddresses())[0];
                    console.log(address);


                    const { script, smartContractAddress } = await getPaymentScriptFromNetworkHandlerV1(networkCheck)

                    const utxos = await wallet.getUtxos();
                    if (utxos.length === 0) {
                        //this is if the seller wallet is empty
                        throw new Error('No UTXOs found in the wallet. Wallet is empty.');
                    }


                    const utxoByHash = await blockchainProvider.fetchUTxOs(
                        request.txHash!,
                    );

                    const utxo = utxoByHash.find((utxo) => utxo.input.txHash == request.txHash);

                    if (!utxo) {
                        throw new Error('UTXO not found');
                    }


                    const buyerVerificationKeyHash = request.BuyerWallet?.walletVkey;
                    const sellerVerificationKeyHash = request.SmartContractWallet!.walletVkey;

                    const utxoDatum = utxo.output.plutusData;
                    if (!utxoDatum) {
                        throw new Error('No datum found in UTXO');
                    }

                    const decodedDatum = cbor.decode(Buffer.from(utxoDatum, 'hex'));
                    if (typeof decodedDatum.value[4] !== 'number') {
                        throw new Error('Invalid datum at position 4');
                    }
                    if (typeof decodedDatum.value[5] !== 'number') {
                        throw new Error('Invalid datum at position 5');
                    }
                    const submitResultTime = decodedDatum.value[4];
                    const unlockTime = decodedDatum.value[5];
                    const refundTime = decodedDatum.value[6];

                    const datum = {
                        value: {
                            alternative: 0,
                            fields: [
                                buyerVerificationKeyHash,
                                sellerVerificationKeyHash,
                                request.identifier,
                                request.resultHash,
                                submitResultTime,
                                unlockTime,
                                refundTime,
                                //is converted to false
                                mBool(false),
                                //is converted to false
                                mBool(true),
                            ],
                        } as Data,
                        inline: true,
                    };

                    const redeemer = {
                        data: {
                            alternative: 5,
                            fields: [],
                        },
                    };
                    const invalidBefore =
                        unixTimeToEnclosingSlot(Date.now() - 150000, SLOT_CONFIG_NETWORK[network]) - 1;

                    const invalidAfter =
                        unixTimeToEnclosingSlot(Date.now() + 150000, SLOT_CONFIG_NETWORK[network]) + 1;

                    const unsignedTx = new Transaction({ initiator: wallet }).setMetadata(674, {
                        msg: ["Masumi", "SubmitResult"],
                    })
                        .redeemValue({
                            value: utxo,
                            script: script,
                            redeemer: redeemer,
                        })
                        .sendAssets(
                            {
                                address: smartContractAddress,
                                datum: datum,
                            },
                            utxo.output.amount
                        )
                        //send to remaining amount the original purchasing wallet
                        .setChangeAddress(address)
                        .setRequiredSigners([address]);

                    unsignedTx.txBuilder.invalidBefore(invalidBefore);
                    unsignedTx.txBuilder.invalidHereafter(invalidAfter);

                    const buildTransaction = await unsignedTx.build();
                    const signedTx = await wallet.signTx(buildTransaction);

                    //submit the transaction to the blockchain
                    const txHash = await wallet.submitTx(signedTx);

                    await prisma.paymentRequest.update({
                        where: { id: request.id }, data: { potentialTxHash: txHash, status: $Enums.PaymentRequestStatus.CompletedInitiated, SmartContractWallet: { update: { PendingTransaction: { create: { hash: txHash } } } } }
                    })

                    logger.info(`Created withdrawal transaction:
                  Tx ID: ${txHash}
                  View (after a bit) on https://${network === 'preprod'
                            ? 'preprod.'
                            : ''
                        }cardanoscan.io/transaction/${txHash}
                  Smart Contract Address: ${smartContractAddress}
              `);
                } catch (error) {
                    logger.error(`Error creating refund transaction: ${error}`);
                    if (request.errorRetries == null || request.errorRetries < networkCheck.maxCollectRefundRetries) {
                        await prisma.paymentRequest.update({
                            where: { id: request.id }, data: { errorRetries: { increment: 1 } }
                        })
                    } else {
                        const errorMessage = "Error creating refund transaction: " + (error instanceof Error ? error.message :
                            (typeof error === 'object' && error ? error.toString() : "Unknown Error"));
                        await prisma.paymentRequest.update({
                            where: { id: request.id },
                            data: {
                                errorType: "UNKNOWN",
                                errorRequiresManualReview: true,
                                errorNote: errorMessage
                            }
                        })
                    }
                }
            }))
        }))

    }
    finally {
        //library is strange as we can release from any non-acquired semaphore
        updateMutex.release()
    }
}

export const cardanoSubmitResultHandlerService = { submitResultV1 }
