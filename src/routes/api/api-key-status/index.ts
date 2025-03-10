import { authenticatedEndpointFactory } from '@/utils/endpoint-factory/authenticated';
import { z } from 'zod';
import { ApiKeyStatus, Permission } from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';



export const getAPIKeyStatusSchemaInput = z.object({
})


export const getAPIKeyStatusSchemaOutput = z.object({
    apiKey: z.string(),
    permission: z.nativeEnum(Permission),
    usageLimited: z.boolean(),
    RemainingUsageCredits: z.array(z.object({
        unit: z.string(),
        amount: z.number({ coerce: true }).int().min(0).max(100000000)
    })),
    status: z.nativeEnum(ApiKeyStatus),
});

export const queryAPIKeyStatusEndpointGet = authenticatedEndpointFactory.build({
    method: "get",
    input: getAPIKeyStatusSchemaInput,
    output: getAPIKeyStatusSchemaOutput,
    handler: async ({ options }) => {
        const result = await prisma.apiKey.findFirst({ where: { id: options.id }, include: { RemainingUsageCredits: true } })
        if (!result) {
            throw createHttpError(500, "API key not found");
        }
        return { ...result, RemainingUsageCredits: result?.RemainingUsageCredits.map((usageCredit) => ({ unit: usageCredit.unit, amount: parseInt(usageCredit.amount.toString()) })) }
    },
});