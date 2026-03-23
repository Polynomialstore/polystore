import {
  buildCreateDealTypedData,
  buildUpdateContentTypedData,
} from "./eip712";

describe("eip712 builders", () => {
  it("builds create deal typed data with stable field order", () => {
    const typed = buildCreateDealTypedData(
      {
        creator: "0xAaBbCcDdEeFf0011223344556677889900AaBbCc",
        duration: 7200n,
        service_hint: "Mode2",
        initial_escrow: "1000stake",
        max_monthly_spend: "10stake",
        nonce: 2n,
      },
      31337,
    );

    expect(typed.primaryType).toBe("CreateDeal");
    expect(typed.domain.chainId).toBe(31337);
    expect(typed.types.CreateDeal.map((field) => field.name)).toEqual([
      "creator",
      "duration",
      "service_hint",
      "initial_escrow",
      "max_monthly_spend",
      "nonce",
    ]);
    expect(typed.message).toEqual({
      creator: "0xaabbccddeeff0011223344556677889900aabbcc",
      duration: "7200",
      service_hint: "Mode2",
      initial_escrow: "1000stake",
      max_monthly_spend: "10stake",
      nonce: "2",
    });
  });

  it("builds update content typed data with stable field order", () => {
    const typed = buildUpdateContentTypedData(
      {
        creator: "0x1111222233334444555566667777888899990000",
        deal_id: 5n,
        previous_manifest_root: "",
        cid: "0xabc123",
        size: 1048576n,
        total_mdus: 9n,
        witness_mdus: 2n,
        nonce: 1n,
      },
      31337,
    );

    expect(typed.primaryType).toBe("UpdateContent");
    expect(typed.types.UpdateContent.map((field) => field.name)).toEqual([
      "creator",
      "deal_id",
      "previous_manifest_root",
      "cid",
      "size",
      "total_mdus",
      "witness_mdus",
      "nonce",
    ]);
    expect(typed.message).toEqual({
      creator: "0x1111222233334444555566667777888899990000",
      deal_id: "5",
      previous_manifest_root: "",
      cid: "0xabc123",
      size: "1048576",
      total_mdus: "9",
      witness_mdus: "2",
      nonce: "1",
    });
  });
});
