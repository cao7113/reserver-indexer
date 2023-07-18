import { Interface } from "@ethersproject/abi";
import { HashZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import * as Sdk from "@reservoir0x/sdk";
import axios from "axios";

import { logger } from "@/common/logger";
import { baseProvider } from "@/common/provider";
import { redis } from "@/common/redis";
import { bn } from "@/common/utils";
import { config } from "@/config/index";
import { Transaction } from "@/models/transactions";
import {
  CollectionMint,
  getCollectionMints,
  simulateAndUpsertCollectionMint,
} from "@/orderbook/mints";
import { fetchMetadata, getStatus, toSafeTimestamp } from "@/orderbook/mints/calldata/helpers";

const STANDARD = "manifold";

export type Info = {
  merkleTreeId?: string;
};

export const extractByCollection = async (
  collection: string,
  tokenId: string,
  extension?: string,
  claimIndex?: string
): Promise<CollectionMint[]> => {
  const extensions = extension
    ? [extension]
    : await new Contract(
        collection,
        new Interface(["function getExtensions() view returns (address[])"]),
        baseProvider
      ).getExtensions();

  const results: CollectionMint[] = [];
  for (const extension of extensions) {
    const c = new Contract(
      extension,
      new Interface([
        `
          function getClaimForToken(address creatorContractAddress, uint256 tokenId) external view returns (
            uint256 instanceId,
            (
              uint32 total,
              uint32 totalMax,
              uint32 walletMax,
              uint48 startDate,
              uint48 endDate,
              uint8 storageProtocol,
              bytes32 merkleRoot,
              string location,
              uint256 tokenId,
              uint256 cost,
              address payable paymentReceiver,
              address erc20
            ) claim
          )
        `,
        "function MINT_FEE() view returns (uint256)",
        "function MINT_FEE_MERKLE() view returns (uint256)",
      ]),
      baseProvider
    );

    // ERC1155
    try {
      const result = await c.getClaimForToken(collection, tokenId);
      const instanceId = bn(result.instanceId).toString();
      const claim = result.claim;

      if (
        instanceId !== "0" &&
        claim.erc20.toLowerCase() === Sdk.Common.Addresses.Eth[config.chainId]
      ) {
        // Public sale
        if (claim.merkleRoot === HashZero) {
          // Include the Manifold mint fee into the price
          const fee = await c.MINT_FEE();
          const price = bn(claim.cost).add(fee).toString();

          return [
            {
              collection,
              contract: collection,
              stage: `claim-${extension.toLowerCase()}-${instanceId}`,
              kind: "public",
              status: "open",
              standard: STANDARD,
              details: {
                tx: {
                  to: extension.toLowerCase(),
                  data: {
                    // `mintBatch`
                    signature: "0x26c858a4",
                    params: [
                      {
                        kind: "contract",
                        abiType: "address",
                      },
                      {
                        kind: "unknown",
                        abiType: "uint256",
                        abiValue: instanceId,
                      },
                      {
                        kind: "quantity",
                        abiType: "uint16",
                      },
                      {
                        kind: "unknown",
                        abiType: "uint32[]",
                        abiValue: [],
                      },
                      {
                        kind: "unknown",
                        abiType: "bytes32[][]",
                        abiValue: [],
                      },
                      {
                        kind: "recipient",
                        abiType: "address",
                      },
                    ],
                  },
                },
              },
              currency: Sdk.Common.Addresses.Eth[config.chainId],
              price,
              tokenId,
              maxMintsPerWallet: bn(claim.walletMax).gt(0) ? claim.walletMax.toString() : undefined,
              maxSupply: bn(claim.totalMax).gt(0) ? claim.totalMax.toString() : undefined,
              startTime: claim.startDate ? toSafeTimestamp(claim.startDate) : undefined,
              endTime: claim.endDate ? toSafeTimestamp(claim.endDate) : undefined,
            },
          ];
        }

        // Allowlist sale
        if (claim.merkleRoot !== HashZero) {
          // Include the Manifold mint fee into the price
          const fee = await c.MINT_FEE_MERKLE();
          const price = bn(claim.cost).add(fee).toString();

          const merkleTreeId = await fetchMetadata(
            `https://apps.api.manifoldxyz.dev/public/instance/data?id=${instanceId}`
          ).then((data) => data.publicData.merkleTreeId);

          return [
            {
              collection,
              contract: collection,
              stage: `claim-${extension.toLowerCase()}-${instanceId}`,
              kind: "allowlist",
              status: "open",
              standard: STANDARD,
              details: {
                tx: {
                  to: extension.toLowerCase(),
                  data: {
                    // `mintBatch`
                    signature: "0x26c858a4",
                    params: [
                      {
                        kind: "contract",
                        abiType: "address",
                      },
                      {
                        kind: "unknown",
                        abiType: "uint256",
                        abiValue: instanceId,
                      },
                      {
                        kind: "quantity",
                        abiType: "uint16",
                      },
                      {
                        kind: "allowlist",
                        abiType: "uint32[]",
                      },
                      {
                        kind: "allowlist",
                        abiType: "bytes32[][]",
                      },
                      {
                        kind: "recipient",
                        abiType: "address",
                      },
                    ],
                  },
                },
                info: {
                  merkleTreeId,
                },
              },
              currency: Sdk.Common.Addresses.Eth[config.chainId],
              price,
              tokenId,
              maxMintsPerWallet: bn(claim.walletMax).gt(0) ? claim.walletMax.toString() : undefined,
              maxSupply: bn(claim.totalMax).gt(0) ? claim.totalMax.toString() : undefined,
              startTime: claim.startDate ? toSafeTimestamp(claim.startDate) : undefined,
              endTime: claim.endDate ? toSafeTimestamp(claim.endDate) : undefined,
              allowlistId: claim.merkleRoot,
            },
          ];
        }
      }
    } catch (error) {
      logger.error("mint-detector", JSON.stringify({ kind: STANDARD, error }));
    }

    // ERC721LazyPayableClaim
    // deployer: 0xa8863bf1c8933f649e7b03eb72109e5e187505ea
    // 0xa46f952645d4deec07a7cd98d1ec9ec888d4b61e
    // 0x7581871e1C11f85ec7F02382632B8574FAd11B22
    // 0x3b8c2feb0f4953870f825df64322ec967aa26b8c

    const IERC721LazyPayableClaimV1 = new Contract(
      extension,
      new Interface([
        `
          function getClaim(address creatorContractAddress, uint256 claimIndex) external view returns (
            (
              uint32 total,
              uint32 totalMax,
              uint32 walletMax,
              uint48 startDate,
              uint48 endDate,
              uint8 storageProtocol,
              bool identical,
              bytes32 merkleRoot,
              string location,
              uint cost,
              address payable paymentReceiver
            ) claim
          )
        `,
      ]),
      baseProvider
    );

    const IERC721LazyPayableClaimV2 = new Contract(
      extension,
      new Interface([
        `
          function getClaim(address creatorContractAddress, uint256 claimIndex) external view returns (
            (
              uint32 total,
              uint32 totalMax,
              uint32 walletMax,
              uint48 startDate,
              uint48 endDate,
              uint8 storageProtocol,
              bool identical,
              bytes32 merkleRoot,
              string location,
              uint cost,
              address payable paymentReceiver,
              address erc20,
            ) claim
          )
        `,
        "function MINT_FEE() view returns (uint256)",
        "function MINT_FEE_MERKLE() view returns (uint256)",
      ]),
      baseProvider
    );

    let claimConfig: {
      total: number;
      totalMax: number;
      walletMax: number;
      startDate: number;
      endDate: number;
      storageProtocol: number;
      identical: boolean;
      merkleRoot: string;
      location: string;
      cost: string;
      paymentReceiver: string;
      erc20: string;
      mintFee: string;
      mintFeeMerkle: string;
    } | null = null;

    try {
      if (claimIndex) {
        const claim = await IERC721LazyPayableClaimV1.getClaim(collection, claimIndex);
        claimConfig = {
          total: claim.total,
          totalMax: claim.totalMax,
          walletMax: claim.walletMax,
          startDate: claim.startDate,
          endDate: claim.endDate,
          storageProtocol: claim.storageProtocol,
          identical: claim.identical,
          merkleRoot: claim.merkleRoot,
          location: claim.location,
          cost: claim.cost.toString(),
          paymentReceiver: claim.paymentReceiver,
          erc20: Sdk.Common.Addresses.Eth[config.chainId],
          mintFee: "0",
          mintFeeMerkle: "0",
        };
      }
    } catch {
      // Skip errors
    }

    try {
      const [claim, mintFee, mintFeeMerkle] = await Promise.all([
        IERC721LazyPayableClaimV2.getClaim(collection, claimIndex),
        IERC721LazyPayableClaimV2.MINT_FEE(),
        IERC721LazyPayableClaimV2.MINT_FEE_MERKLE(),
      ]);
      claimConfig = {
        total: claim.total,
        totalMax: claim.totalMax,
        walletMax: claim.walletMax,
        startDate: claim.startDate,
        endDate: claim.endDate,
        storageProtocol: claim.storageProtocol,
        identical: claim.identical,
        merkleRoot: claim.merkleRoot,
        location: claim.location,
        cost: claim.cost.toString(),
        paymentReceiver: claim.paymentReceiver,
        erc20: claim.erc20,
        mintFee: mintFee.toString(),
        mintFeeMerkle: mintFeeMerkle.toString(),
      };
    } catch {
      // Skip errors
    }

    if (claimConfig) {
      // Public sale
      if (claimConfig.merkleRoot === HashZero) {
        // Include the Manifold mint fee into the price
        const price = bn(claimConfig.cost).add(bn(claimConfig.mintFee)).toString();
        return [
          {
            collection,
            contract: collection,
            stage: `claim-${extension.toLowerCase()}-${claimIndex}`,
            kind: "public",
            status: "open",
            standard: STANDARD,
            details: {
              tx: {
                to: extension.toLowerCase(),
                data: {
                  // `mintBatch`
                  signature: "0x26c858a4",
                  params: [
                    {
                      kind: "contract",
                      abiType: "address",
                    },
                    {
                      kind: "unknown",
                      abiType: "uint256",
                      abiValue: claimIndex,
                    },
                    {
                      kind: "quantity",
                      abiType: "uint16",
                    },
                    {
                      kind: "unknown",
                      abiType: "uint32[]",
                      abiValue: [],
                    },
                    {
                      kind: "unknown",
                      abiType: "bytes32[][]",
                      abiValue: [],
                    },
                    {
                      kind: "recipient",
                      abiType: "address",
                    },
                  ],
                },
              },
            },
            currency: Sdk.Common.Addresses.Eth[config.chainId],
            price,
            tokenId,
            maxMintsPerWallet: bn(claimConfig.walletMax).gt(0)
              ? claimConfig.walletMax.toString()
              : undefined,
            maxSupply: bn(claimConfig.totalMax).gt(0) ? claimConfig.totalMax.toString() : undefined,
            startTime: claimConfig.startDate ? toSafeTimestamp(claimConfig.startDate) : undefined,
            endTime: claimConfig.endDate ? toSafeTimestamp(claimConfig.endDate) : undefined,
          },
        ];
      }

      // Allowlist sale
      if (claimConfig.merkleRoot !== HashZero) {
        // Include the Manifold mint fee into the price
        const price = bn(claimConfig.cost).add(bn(claimConfig.mintFeeMerkle)).toString();

        const merkleTreeId = await fetchMetadata(
          `https://apps.api.manifoldxyz.dev/public/instance/data?id=${claimIndex}`
        ).then((data) => data.publicData.merkleTreeId);

        return [
          {
            collection,
            contract: collection,
            stage: `claim-${extension.toLowerCase()}-${claimIndex}`,
            kind: "allowlist",
            status: "open",
            standard: STANDARD,
            details: {
              tx: {
                to: extension.toLowerCase(),
                data: {
                  // `mintBatch`
                  signature: "0x26c858a4",
                  params: [
                    {
                      kind: "contract",
                      abiType: "address",
                    },
                    {
                      kind: "unknown",
                      abiType: "uint256",
                      abiValue: claimIndex,
                    },
                    {
                      kind: "quantity",
                      abiType: "uint16",
                    },
                    {
                      kind: "allowlist",
                      abiType: "uint32[]",
                    },
                    {
                      kind: "allowlist",
                      abiType: "bytes32[][]",
                    },
                    {
                      kind: "recipient",
                      abiType: "address",
                    },
                  ],
                },
              },
              info: {
                merkleTreeId,
              },
            },
            currency: Sdk.Common.Addresses.Eth[config.chainId],
            price,
            maxMintsPerWallet: bn(claimConfig.walletMax).gt(0)
              ? claimConfig.walletMax.toString()
              : undefined,
            maxSupply: bn(claimConfig.totalMax).gt(0) ? claimConfig.totalMax.toString() : undefined,
            startTime: claimConfig.startDate ? toSafeTimestamp(claimConfig.startDate) : undefined,
            endTime: claimConfig.endDate ? toSafeTimestamp(claimConfig.endDate) : undefined,
            allowlistId: claimConfig.merkleRoot,
          },
        ];
      }
    }
  }

  // Update the status of each collection mint
  await Promise.all(
    results.map(async (cm) => {
      await getStatus(cm).then(({ status, reason }) => {
        cm.status = status;
        cm.statusReason = reason;
      });
    })
  );

  return results;
};

export const extractByTx = async (
  collection: string,
  tokenId: string,
  tx: Transaction
): Promise<CollectionMint[]> => {
  if (
    [
      "0xfa2b068f", // `mint`
      "0x26c858a4", // `mintBatch`
    ].some((bytes4) => tx.data.startsWith(bytes4))
  ) {
    let instanceId: string | undefined;
    try {
      instanceId = new Interface([
        "function mint(address creatorContractAddress, uint256 instanceId, uint32 mintIndex, bytes32[] calldata merkleProof, address mintFor)",
        "function mintBatch(address creatorContractAddress, uint256 instanceId, uint16 mintCount, uint32[] calldata mintIndices, bytes32[][] calldata merkleProofs, address mintFor)",
      ])
        .decodeFunctionData(tx.data.startsWith("0xfa2b068f") ? "mint" : "mintBatch", tx.data)
        .instanceId.toString();
    } catch {
      // Skip errors
    }
    return extractByCollection(collection, tokenId, tx.to, instanceId);
  }

  return [];
};

export const refreshByCollection = async (collection: string) => {
  const existingCollectionMints = await getCollectionMints(collection, { standard: STANDARD });

  for (const { tokenId } of existingCollectionMints.filter((cm) => cm.tokenId)) {
    // Fetch and save/update the currently available mints
    const latestCollectionMints = await extractByCollection(collection, tokenId!);
    for (const collectionMint of latestCollectionMints) {
      await simulateAndUpsertCollectionMint(collectionMint);
    }

    // Assume anything that exists in our system but was not returned
    // in the above call is not available anymore so we can close
    for (const existing of existingCollectionMints) {
      if (
        !latestCollectionMints.find(
          (latest) =>
            latest.collection === existing.collection &&
            latest.stage === existing.stage &&
            latest.tokenId === existing.tokenId
        )
      ) {
        await simulateAndUpsertCollectionMint({
          ...existing,
          status: "closed",
        });
      }
    }
  }
};

type ProofValue = { merkleProof: string[]; value: string };

export const generateProofValue = async (
  collectionMint: CollectionMint,
  address: string
): Promise<ProofValue> => {
  const cacheKey = `${collectionMint.collection}-${collectionMint.stage}-${collectionMint.tokenId}`;

  let result: ProofValue = await redis
    .get(cacheKey)
    .then((response) => (response ? JSON.parse(response) : undefined));
  if (!result) {
    const info = collectionMint.details.info!;
    result = await axios
      .get(
        `https://apps.api.manifoldxyz.dev/public/merkleTree/${info.merkleTreeId}/merkleInfo?address=${address}`
      )
      .then(({ data }: { data: { merkleProof: string[]; value: string }[] }) => data[0]);

    if (result) {
      await redis.set(cacheKey, JSON.stringify(result), "EX", 3600);
    }
  }

  return result;
};
