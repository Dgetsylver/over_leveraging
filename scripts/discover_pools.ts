/**
 * Discover all known Blend v2 mainnet pools:
 * query each pool's config (oracle, backstop_take_rate) and
 * list all reserves (asset IDs + config).
 */
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  rpc as SorobanRpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

const RPC_URL = "https://rpc.lightsail.network/";
const NETWORK  = Networks.PUBLIC;
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const POOLS: { name: string; id: string }[] = [
  { name: "Etherfuse",  id: "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI" },
  { name: "Fixed v2",   id: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD" },
  { name: "YieldBlox v2", id: "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS" },
  // v1 pools (different ABI, listed for reference)
  { name: "Fixed v1",   id: "CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP" },
  { name: "YieldBlox v1", id: "CBP7NO6F7FRDHSOFQBT2L2UWYIZ2PU76JKVRYAQTG3KZSQLYAOKIF2WB" },
];

const server = new SorobanRpc.Server(RPC_URL);
const bigIntReplacer = (_: string, v: any) => typeof v === "bigint" ? v.toString() : v;

async function sim(op: xdr.Operation): Promise<any> {
  const acc = new Account(NULL_ACCOUNT, "0");
  const tx  = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(op).setTimeout(30).build();
  const result = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(result)) {
    return { error: (result as any).error };
  }
  return scValToNative(result.result!.retval);
}

async function main() {
  for (const pool of POOLS) {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`Pool: ${pool.name}  (${pool.id})`);

    const contract = new Contract(pool.id);

    // Fetch pool config
    const config = await sim(contract.call("config"));
    console.log("  config:", JSON.stringify(config, bigIntReplacer, 2));

    // Fetch reserve list
    const reserveList = await sim(contract.call("get_reserve_list"));
    console.log("  reserve_list:", JSON.stringify(reserveList, bigIntReplacer));

    if (Array.isArray(reserveList)) {
      for (const assetId of reserveList) {
        const reserve = await sim(contract.call("get_reserve", new Address(assetId).toScVal()));
        console.log(`  reserve[${assetId}]:`, JSON.stringify(reserve?.config, bigIntReplacer));
      }
    }
  }
}

main().catch(console.error);
