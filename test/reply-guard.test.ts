import { Controller } from "st-ethernet-ip";
import {
  guardReplyHandlers,
  LIB_REPLY_HANDLERS,
  cipErrorFields,
  describeCipError,
} from "../src/utils";

/**
 * A Multiple Service Packet reply with outer status 0 whose first embedded reply failed
 * (0x05, path destination unknown). st-ethernet-ip 2.7.5 dereferences null on it
 * (SerafinTech/ST-node-ethernet-ip#84).
 */
function badMspReply(): Buffer {
  const failed = Buffer.from([0xcc, 0x00, 0x05, 0x00]);
  const ok = Buffer.from([
    0xcc, 0x00, 0x00, 0x00, 0xc4, 0x00, 0x01, 0x00, 0x00, 0x00,
  ]);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(2, 0);
  header.writeUInt16LE(6, 2);
  header.writeUInt16LE(6 + failed.length, 4);
  return Buffer.concat([
    Buffer.from([0x8a, 0x00, 0x00, 0x00]),
    header,
    failed,
    ok,
  ]);
}

const srrd = (data: Buffer) => [{}, { data }];

describe("guardReplyHandlers", () => {
  it("still finds the library handlers it wraps", () => {
    // If this fails, st-ethernet-ip renamed its private handlers and the guard is a no-op.
    const plc: any = new Controller(false);
    for (const name of LIB_REPLY_HANDLERS)
      expect(typeof plc[name]).toBe("function");
  });

  it("the unguarded library throws on the reply", () => {
    const plc: any = new Controller(false);
    expect(() => plc._handleSendRRDataReceived(srrd(badMspReply()))).toThrow(
      TypeError,
    );
  });

  it("swallows the throw, warns and fails the batch with 0x1E", () => {
    const plc: any = new Controller(false);
    const warn = jest.fn();
    guardReplyHandlers(plc, warn);
    const seen = jest.fn();
    plc.on("Multiple Service Packet", seen);

    expect(() =>
      plc._handleSendRRDataReceived(srrd(badMspReply())),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not handle"),
    );
    expect(seen).toHaveBeenCalledWith(
      { generalStatusCode: 0x1e, extendedStatus: [] },
      [],
    );
  });

  it("leaves well-formed replies alone", () => {
    const plc: any = new Controller(false);
    const warn = jest.fn();
    guardReplyHandlers(plc, warn);
    const seen = jest.fn();
    plc.on("Read Tag", seen);

    const readOk = Buffer.from([
      0xcc, 0x00, 0x00, 0x00, 0xc4, 0x00, 0x2a, 0x00, 0x00, 0x00,
    ]);
    plc._handleSendRRDataReceived(srrd(readOk));
    expect(warn).not.toHaveBeenCalled();
    expect(seen).toHaveBeenCalledWith(null, expect.any(Buffer));
  });

  it("does not emit for a non-MSP reply that throws", () => {
    const plc: any = new Controller(false);
    const warn = jest.fn();
    guardReplyHandlers(plc, warn);
    const seen = jest.fn();
    plc.on("Multiple Service Packet", seen);

    plc._handleSendUnitDataReceived([{}, { data: Buffer.alloc(0) }]);
    expect(warn).toHaveBeenCalled();
    expect(seen).not.toHaveBeenCalled();
  });
});

describe("cipErrorFields", () => {
  it("turns a bare library rejection into text plus codes", () => {
    expect(
      cipErrorFields({ generalStatusCode: 0x0e, extendedStatus: [] }),
    ).toEqual({
      error: "Attribute not settable (CIP 0x0e)",
      generalStatusCode: 0x0e,
      extendedStatus: [],
    });
  });

  it("keeps a plain Error as text only", () => {
    expect(cipErrorFields(new Error("Not connected to PLC"))).toEqual({
      error: "Not connected to PLC",
    });
  });

  it("names 0x1E as the embedded service error a failed batch entry produces", () => {
    expect(
      describeCipError({ generalStatusCode: 0x1e, extendedStatus: [] }),
    ).toBe("Embedded service error (CIP 0x1e)");
  });
});
