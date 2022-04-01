import cloneDeep from 'lodash.clonedeep';
import times from 'lodash.times';
import chunk from 'lodash.chunk';
import getDebugger from 'debug';
import type {DocumentClient} from 'aws-sdk/lib/dynamodb/document_client';
import {Readable} from 'stream';
import {getTableItemsCount, scan} from './ddb';
import {Blocker} from './blocker';

const debug = getDebugger('ddb-parallel-scan');

let totalTableItemsCount = 0;
let totalScannedItemsCount = 0;
let totalFetchedItemsCount = 0;

export async function parallelScanAsStream(
  scanParams: DocumentClient.ScanInput,
  {
    concurrency,
    chunkSize,
    highWaterMark = Number.MAX_SAFE_INTEGER,
  }: {concurrency: number; chunkSize: number; highWaterMark?: number}
): Promise<Readable> {
  totalTableItemsCount = await getTableItemsCount(scanParams.TableName);

  const segments: number[] = times(concurrency);

  const blocker = new Blocker();

  const stream = new Readable({
    objectMode: true,
    highWaterMark,
    read() {
      if (blocker.isBlocked() && this.readableLength - chunkSize < this.readableHighWaterMark) {
        blocker.unblock();
      }

      return;
    },
  });

  debug(
    `Started parallel scan with ${concurrency} threads. Total items count: ${totalTableItemsCount}`
  );

  Promise.all(
    segments.map(async (_, segmentIndex) =>
      getItemsFromSegment({
        scanParams,
        stream,
        concurrency,
        segmentIndex,
        chunkSize,
        blocker,
      })
    )
  ).then(() => {
    // mark that there will be nothing else pushed into a stream
    stream.push(null);
  });

  return stream;
}

async function getItemsFromSegment({
  scanParams,
  stream,
  concurrency,
  segmentIndex,
  chunkSize,
  blocker,
}: {
  scanParams: DocumentClient.ScanInput;
  stream: Readable;
  concurrency: number;
  segmentIndex: number;
  chunkSize: number;
  blocker: Blocker;
}): Promise<void> {
  let segmentItems: DocumentClient.ItemList = [];
  let ExclusiveStartKey: DocumentClient.Key;

  const params: DocumentClient.ScanInput = {
    ...cloneDeep(scanParams),
    Segment: segmentIndex,
    TotalSegments: concurrency,
  };

  debug(`[${segmentIndex}/${concurrency}][start]`, {ExclusiveStartKey});

  do {
    await blocker.get();

    const now: number = Date.now();

    if (ExclusiveStartKey) {
      params.ExclusiveStartKey = ExclusiveStartKey;
    }

    const {Items, LastEvaluatedKey, ScannedCount} = await scan(params);
    ExclusiveStartKey = LastEvaluatedKey;
    totalScannedItemsCount += ScannedCount;

    debug(
      `(${Math.round((totalScannedItemsCount / totalTableItemsCount) * 100)}%) ` +
        `[${segmentIndex}/${concurrency}] [time:${Date.now() - now}ms] ` +
        `[fetched:${Items.length}] ` +
        `[total (fetched/scanned/table-size):${totalFetchedItemsCount}/${totalScannedItemsCount}/${totalTableItemsCount}]`
    );

    segmentItems = segmentItems.concat(Items);

    if (segmentItems.length < chunkSize) {
      continue;
    }

    for (const itemsOfChunkSize of chunk(segmentItems, chunkSize)) {
      const isUnderHighWaterMark = stream.push(itemsOfChunkSize);
      totalFetchedItemsCount += itemsOfChunkSize.length;

      if (!isUnderHighWaterMark) {
        blocker.block();
      }
    }

    segmentItems = [];
  } while (ExclusiveStartKey);

  if (segmentItems.length) {
    stream.push(segmentItems);
    totalFetchedItemsCount += segmentItems.length;
  }
}
