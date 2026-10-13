/**
 * Issue #20: cip-controller's run/program/test wrote the Identity Status word, and
 * "reset" sent the Identity Reset service, which restarts the device. Both are now
 * refused without sending anything; getProps/getStatus read as documented.
 */
import * as path from "path";

const CONTROLLER_NODE = path.join(__dirname, "..", "nodes", "cip-controller.js");

function makeControllerNode() {
  const sent: Buffer[] = [];
  const plc = {
    state: { name: "Sim", status: 0x0060, tagList: [] },
    write_cip(data: Buffer, _c: any, _t: any, cb: any) {
      sent.push(data);
      if (cb) cb(null);
    },
  };
  const endpoint = {
    connected: true,
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
  require(CONTROLLER_NODE)(RED);

  const handlers: Record<string, any> = {};
  const node: any = Object.create(RED._ctor.prototype);
  const errors: string[] = [];
  const outputs: any[] = [];
  let settle: () => void = () => {};
  node.status = () => {};
  node.log = () => {};
  node.debug = () => {};
  node.warn = () => settle();
  node.error = (e: any) => {
    errors.push(e instanceof Error ? e.message : String(e));
    settle();
  };
  node.on = (ev: string, cb: any) => {
    handlers[ev] = cb;
  };
  node.send = (msg: any) => {
    outputs.push(msg);
    settle();
  };

  RED._ctor.call(node, { endpoint: "ep", pollInterval: 0 });

  const command = (cmd: string): Promise<void> =>
    new Promise((resolve) => {
      settle = resolve;
      handlers.input({ command: cmd });
    });

  return { command, sent, errors, outputs, close: () => handlers.close?.(() => {}) };
}

describe("cip-controller commands", () => {
  it.each(["run", "program", "test"])("refuses %s without sending a request", async (cmd) => {
    const n = makeControllerNode();
    await n.command(cmd);
    expect(n.errors[0]).toMatch(/Changing the controller mode over CIP is not supported/);
    expect(n.sent).toHaveLength(0);
    n.close();
  });

  it("refuses reset, which would restart the device", async () => {
    const n = makeControllerNode();
    await n.command("reset");
    expect(n.errors[0]).toMatch(/Fault reset over CIP is not supported/);
    expect(n.sent).toHaveLength(0);
    n.close();
  });

  it.each(["getProps", "getStatus"])("%s reads the controller", async (cmd) => {
    const n = makeControllerNode();
    await n.command(cmd);
    expect(n.errors).toHaveLength(0);
    expect(n.outputs[0].payload.name).toBe("Sim");
    n.close();
  });
});
