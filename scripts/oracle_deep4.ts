import { StrKey, rpc as SorobanRpc, xdr, scValToNative } from "@stellar/stellar-sdk";

const ORACLE_ID = "CAVRP26CWW6IUEXBRA3Q2T2SHBUVBC2DF43M4E23LEZGW5ZEIB62HALS";
const server = new SorobanRpc.Server("https://rpc.lightsail.network/");

async function main() {
  const contractIdBytes = StrKey.decodeContract(ORACLE_ID);
  const contractHash = xdr.Hash.fromXDR(Buffer.from(contractIdBytes));
  const contractAddr = xdr.ScAddress.scAddressTypeContract(contractHash);
  
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractAddr,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );

  const result = await server.getLedgerEntries(ledgerKey);
  if (!result.entries?.length) { console.log("No entry"); return; }

  const rawXdr = result.entries[0].val.toXDR("base64");
  const parsed = xdr.LedgerEntryData.fromXDR(rawXdr, "base64");
  const cd = parsed.contractData();
  const val = cd.val();
  
  // Use instance() method
  const inst = (val as any).instance();
  console.log("Instance methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(inst)).filter(m => typeof inst[m] === 'function' && m !== 'constructor').join(", "));
  
  const exec = inst.executable();
  console.log("Executable type:", exec.switch().name);
  if (exec.switch().name === 'contractExecutableWasm') {
    console.log("WASM hash:", exec.wasmHash().toString('hex'));
  }
  
  const st = inst.storage();
  if (st && st.length > 0) {
    console.log(`\nInstance storage (${st.length} entries):`);
    for (const item of st) {
      try {
        const k = scValToNative(item.key());
        const v = scValToNative(item.val());
        console.log(`  [${JSON.stringify(k)}]:`, JSON.stringify(v, (_, v) => typeof v === "bigint" ? v.toString() : v));
      } catch { console.log("  (parse error)"); }
    }
  } else {
    console.log("No instance storage or empty");
  }
}

main().catch(console.error);
