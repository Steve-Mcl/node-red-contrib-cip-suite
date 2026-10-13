/**
 * Issue #21, the nodes beyond read/write: a request the library rejects with a bare CIP
 * status object must reach the flow as readable text plus the codes, not "undefined".
 */
import * as path from "path";

function makeNode(file: string, config: Record<string, any>) {
  const refusal = { generalStatusCode: 0x0e, extendedStatus: [] };
  const plc = {
    write_cip(_req: Buffer, _c: any, _t: any, cb: any) {
      cb(refusal);
    },
  };
  const endpoint = {
    connected: true,
    // Both ways a node can send a raw request fail the same way.
    request: () => Promise.reject(refusal),
    getController: () => plc,
    register: () => {},
    deregister: () => {},
  };
  const RED: any = {
    nodes: {
      createNode() {},
      getNode: () => endpoint,
      registerType(_name: string, ctor: any) {
        RED._ctor = ctor;
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(path.join(__dirname, "..", "nodes", file))(RED);

  const handlers: Record<string, any> = {};
  const node: any = Object.create(RED._ctor.prototype);
  const errors: string[] = [];
  node.status = () => {};
  node.log = () => {};
  node.warn = () => {};
  node.error = (e: any) => errors.push(String(e));
  node.on = (ev: string, cb: any) => {
    handlers[ev] = cb;
  };
  RED._ctor.call(node, { endpoint: "ep", ...config });

  const input = (msg: Record<string, any>): Promise<any> =>
    new Promise((resolve) => {
      node.send = resolve;
      handlers.input(msg);
    });
  return { input, errors };
}

describe("CIP errors reach the flow as text", () => {
  it("cip-param", async () => {
    const n = makeNode("cip-param.js", { paramInstance: 1 });
    const msg = await n.input({ command: "write", payload: 5 });
    expect(msg.payload).toEqual({
      success: false,
      error: "Attribute not settable (CIP 0x0e)",
      generalStatusCode: 0x0e,
      extendedStatus: [],
    });
    expect(n.errors[0]).toBe("Parameter error: Attribute not settable (CIP 0x0e)");
  });
});
