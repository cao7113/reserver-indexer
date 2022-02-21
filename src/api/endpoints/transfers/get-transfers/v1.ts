import { Request, RouteOptions } from "@hapi/hapi";
import Joi from "joi";

import { db } from "@/common/db";
import { logger } from "@/common/logger";
import { formatEth, fromBuffer, toBuffer } from "@/common/utils";

const version = "v1";

export const getTransfersV1Options: RouteOptions = {
  description:
    "Get historical transfer events. Can filter by collection, attribute or token.",
  tags: ["api", "transfers"],
  validate: {
    query: Joi.object({
      collection: Joi.string().lowercase(),
      contract: Joi.string()
        .lowercase()
        .pattern(/^0x[a-f0-9]{40}$/),
      tokenId: Joi.string().pattern(/^[0-9]+$/),
      offset: Joi.number().integer().min(0).max(10000).default(0),
      limit: Joi.number().integer().min(1).max(100).default(20),
    })
      .oxor("collection", "contract")
      .or("collection", "contract")
      .with("tokenId", "contract"),
  },
  response: {
    schema: Joi.object({
      transfers: Joi.array().items(
        Joi.object({
          token: Joi.object({
            contract: Joi.string()
              .lowercase()
              .pattern(/^0x[a-f0-9]{40}$/),
            tokenId: Joi.string().pattern(/^[0-9]+$/),
            name: Joi.string().allow(null, ""),
            image: Joi.string().allow(null, ""),
            collection: Joi.object({
              id: Joi.string().allow(null),
              name: Joi.string().allow(null, ""),
            }),
          }),
          from: Joi.string()
            .lowercase()
            .pattern(/^0x[a-f0-9]{40}$/),
          to: Joi.string()
            .lowercase()
            .pattern(/^0x[a-f0-9]{40}$/),
          amount: Joi.number(),
          txHash: Joi.string()
            .lowercase()
            .pattern(/^0x[a-f0-9]{64}$/),
          timestamp: Joi.number(),
          price: Joi.number().unsafe().allow(null),
        })
      ),
    }).label(`getTransfers${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(
        `get-transfers-${version}-handler`,
        `Wrong response schema: ${error}`
      );
      throw error;
    },
  },
  handler: async (request: Request) => {
    const query = request.query as any;

    try {
      let baseQuery = `
        SELECT
          "nte"."address",
          "nte"."token_id",
          "t"."name",
          "t"."image",
          "t"."collection_id",
          "c"."name" as "collection_name",
          "nte"."from",
          "nte"."to",
          "nte"."amount",
          "nte"."tx_hash",
          "nte"."timestamp",
          (
            SELECT "fe"."price" FROM "fill_events_2" "fe"
            WHERE "fe"."tx_hash" = "nte"."tx_hash"
              AND "fe"."log_index" = "nte"."log_index" + 1
            LIMIT 1
          ) AS "price"
        FROM "nft_transfer_events" "nte"
        JOIN "tokens" "t"
          ON "nte"."address" = "t"."contract"
          AND "nte"."token_id" = "t"."token_id"
        JOIN "collections" "c"
          ON "t"."collection_id" = "c"."id"
      `;

      // Filters
      const conditions: string[] = [];
      if (query.collection) {
        conditions.push(`"t"."collection_id" = $/collection/`);
      }
      if (query.contract) {
        (query as any).contract = toBuffer(query.contract);
        conditions.push(`"nte"."address" = $/contract/`);
      }
      if (query.tokenId) {
        conditions.push(`"nte"."token_id" = $/tokenId/`);
      }
      if (conditions.length) {
        baseQuery += " WHERE " + conditions.map((c) => `(${c})`).join(" AND ");
      }

      // Sorting
      baseQuery += ` ORDER BY "nte"."block" DESC`;

      // Pagination
      baseQuery += ` OFFSET $/offset/`;
      baseQuery += ` LIMIT $/limit/`;

      const result = await db.manyOrNone(baseQuery, query).then((result) =>
        result.map((r) => ({
          token: {
            contract: fromBuffer(r.address),
            tokenId: r.token_id,
            name: r.name,
            image: r.mage,
            collection: {
              id: r.collection_id,
              name: r.collection_name,
            },
          },
          from: fromBuffer(r.from),
          to: fromBuffer(r.to),
          amount: Number(r.amount),
          txHash: fromBuffer(r.tx_hash),
          timestamp: r.timestamp,
          price: r.price ? formatEth(r.price) : null,
        }))
      );

      return { transfers: result };
    } catch (error) {
      logger.error(
        `get-transfers-${version}-handler`,
        `Handler failure: ${error}`
      );
      throw error;
    }
  },
};
