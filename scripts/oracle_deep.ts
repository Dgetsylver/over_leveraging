import { StrKey, rpc as SorobanRpc, xdr, scValToNative } from "@stellar/stellar-sdk";

const ORACLE_ID = "CAVRP26CWW6IUEXBRA3Q2T2SHBUVBC2DF43M4E23LEZGW5ZEIB62HALS";
const server = new SorobanRpc.Server("https://rpc.lightsail.network/");

async function main() {
  const contractIdBytes = StrKey.decodeContract(ORACLE_ID);
  const contractHash = xdr.Hash.fromXDR(Buffer.from(contractIdBytes));
  const contractAddr = xdr.ScAddress.scAddressTypeContract(contractHash);
  
  // Read instance
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractAddr,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );

  const result = await server.getLedgerEntries(ledgerKey);
  if (!result.entries?.length) { console.log("No entry"); return; }

  const entryXdr = result.entries[0].val;
  // Access the raw XDR
  const contractData = (entryXdr as any).value().data();
  const storedVal = contractData.val();
  
  // Try different access patterns
  try {
    const instance = storedVal.instance ? storedVal.instance() : storedVal.contractInstance?.();
    if (instance) {
      const exec = instance.executable();
      console.log("Executable type:", exec.switch().name);
      if (exec.switch().name === "contractExecutableWasm") {
        console.log("WASM hash:", exec.wasmHash().toString("hex"));
      }
      const storage = instance.storage();
      if (storage) {
        for (const item of storage) {
          const k = scValToNative(item.key());
          const v = scValToNative(item.val());
          console.log(`Storage [${JSON.stringify(k)}]:`, JSON.stringify(v, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
        }
      }
    }
  } catch(e) {
    // Try raw XDR parsing
    const raw = (entryXdr as any).toXDR("base64");
    console.log("Raw XDR (first 200 chars):", raw.slice(0, 200));
    
    // Parse as contract data directly
    try {
      const parsed = xdr.LedgerEntryData.fromXDR(raw, "base64");
      const cd = parsed.contractData();
      const val = cd.val();
      console.log("Val switch:", val.switch().name);
      if (val.switch().name === "scvContractInstance") {
        const inst = val.contractInstance();
        const exec = inst.executable();
        console.log("Executable:", exec.switch().name);
        if (exec.switch().name === "contractExecutableWasm") {
          console.log("WASM hash:", exec.wasmHash().toString("hex"));
        }
        const st = inst.storage();
        if (st) {
          console.log(`\nInstance storage (${st.length} entries):`);
          for (const item of st) {
            try {
              const k = scValToNative(item.key());
              const v = scValToNative(item.val());
              console.log(`  [${JSON.stringify(k)}]:`, JSON.stringify(v, (_, v) => typeof v === "bigint" ? v.toString() : v));
            } catch {
              console.log(`  key: ${item.key().switch().name}, val: ${item.val().switch().name}`);
            }
          }
        }
      }
    } catch(e2) {
      console.log("Parse error:", (e2 as any).message?.slice(0, 200));
    }
  }

  // Also check persistent storage keys
  console.log("\n=== Checking persistent storage for price-related keys ===");
  for (const keyName of ["Prices", "prices", "Admin", "Oracle", "Source", "Config"]) {
    try {
      const key = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: contractAddr,
          key: xdr.ScVal.scvSymbol(keyName),
          durability: xdr.ContractDataDurability.persistent(),
        })
      );
      const r = await server.getLedgerEntries(key);
      if (r.entries?.length) {
        const data = r.entries[0].val;
        const raw = (data as any).toXDR("base64");
        const parsed = xdr.LedgerEntryData.fromXDR(raw, "base64");
        const val = scValToNative(parsed.contractData().val());
        console.log(`${keyName}:`, JSON.stringify(val, (_, v) => typeof v === "bigint" ? v.toString() : v));
      }
    } catch {}
  }

  // Check instance storage keys
  for (const keyName of ["Prices", "prices", "Admin", "admin", "Oracle", "oracle", "Source", "source"]) {
    try {
      const key = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: contractAddr,
          key: xdr.ScVal.scvSymbol(keyName),
          durability: xdr.ContractDataDurability.instance(),
        })
      );
      const r = await server.getLedgerEntries(key);
      if (r.entries?.length) {
        const data = r.entries[0].val;
        const raw = (data as any).toXDR("base64");
        const parsed = xdr.LedgerEntryData.fromXDR(raw, "base64");
        const val = scValToNative(parsed.contractData().val());
        console.log(`Instance[${keyName}]:`, JSON.stringify(val, (_, v) => typeof v === "bigint" ? v.toString() : v));
      }
    } catch {}
  }
}

main().catch(console.error);
