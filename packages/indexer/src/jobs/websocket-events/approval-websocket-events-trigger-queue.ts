import { Job, Queue, QueueScheduler, Worker } from "bullmq";

import { logger } from "@/common/logger";
import { redis } from "@/common/redis";
import { config } from "@/config/index";

import { randomUUID } from "crypto";
import _ from "lodash";

import { redisWebsocketPublisher } from "@/common/redis";

const QUEUE_NAME = "approval-websocket-events-trigger-queue";

export const queue = new Queue(QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
    removeOnComplete: 1000,
    removeOnFail: 1000,
    timeout: 60000,
  },
});
new QueueScheduler(QUEUE_NAME, { connection: redis.duplicate() });

// BACKGROUND WORKER ONLY
if (config.doBackgroundWork && config.doWebsocketServerWork) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const { data } = job.data as EventInfo;

      try {
        const { eventData } = data;
        const result = {
          address: eventData.address,
          block: eventData.block,
          timestamp: new Date(eventData.timestamp).toISOString(),
          owner: eventData.owner,
          operator: eventData.operator,
          approved: eventData.approved,
        };

        let eventType = "";
        if (data.trigger === "insert") eventType = "approval.created";
        else if (data.trigger === "update") eventType = "approval.updated";

        await redisWebsocketPublisher.publish(
          "events",
          JSON.stringify({
            event: eventType,
            tags: {
              address: result.address,
              owner: result.owner,
              approved: result.approved,
            },
            data: result,
          })
        );
      } catch (error) {
        logger.error(
          QUEUE_NAME,
          `Error processing websocket event. data=${JSON.stringify(data)}, error=${JSON.stringify(
            error
          )}`
        );
        throw error;
      }
    },
    { connection: redis.duplicate(), concurrency: 80 }
  );

  worker.on("error", (error) => {
    logger.error(QUEUE_NAME, `Worker errored. error=${JSON.stringify(error)}`);
  });
}

export type EventInfo = {
  data: ApprovalWebsocketEventInfo;
};

export const addToQueue = async (events: EventInfo[]) => {
  if (!config.doWebsocketServerWork) {
    return;
  }

  await queue.addBulk(
    _.map(events, (event) => ({
      name: randomUUID(),
      data: event,
    }))
  );
};

export type ApprovalWebsocketEventInfo = {
  eventData: {
    address: string;
    block: string;
    timestamp: string;
    owner: string;
    operator: string;
    approved: string;
  };
  trigger: "insert" | "update" | "delete";
};
