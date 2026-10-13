/**
 * Issue #28: write_cip's callback is the socket write callback and never carries the
 * reply, so the raw CIP nodes got nothing back. endpoint.request() waits for the reply
 * event instead. Run against the simulator in both messaging modes: Logix (connected,
 * SendUnitData) and Micro800 (unconnected, SendRRData).
 */
import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as path from "path";

const SIM = path.join(__dirname, "..", "simulator", "server.js");
const NODES = path.join(__dirname, "..", "nodes");
const TCP_PORT = 44818;

/** Get_Attribute_Single, Identity instance 1, attribute 1 (vendor id). */
const GET_VENDOR = Buffer.from([0x0e, 0x03, 0x20, 0x01, 0x24, 0x01, 0x30, 0x01]);

function startSim(plcType: string): Promise<ChildProcess> {
  const proc = spawn(process.execPath, [SIM], {
    env: { ...process.env, PLC_TYPE: plcType, EIP_PORT: String(TCP_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("simulator did not start in time")), 8000);
    proc.stdout!.on("data", (b: Buffer) => {
      if (b.toString().includes("CIP PLC Simulator")) {
        clearTimeout(t);
        resolve(proc);
      }
    });
    proc.on("error", reject);
  });
}

function stubRED(): any {
  const RED: any = {
    nodes: {
      createNode(node: any, cfg: any) {
        node.id = cfg.id;
        node.name = cfg.name;
      },
      registerType(type: string, ctor: any) {
        RED.types[type] = ctor;
      },
      getNode: () => RED.endpoint,
      eachNode: () => undefined,
    },
    httpAdmin: { get: () => undefined },
    auth: { needsPermission: () => () => undefined },
    log: { info() {}, warn() {}, error() {} },
    types: {} as Record<string, any>,
  };
  return RED;
}

async function makeEndpoint(RED: any, useMicro800: boolean): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(path.join(NODES, "cip-endpoint.js"))(RED);
  const node: any = new EventEmitter();
  node.log = () => {};
  node.warn = () => {};
  node.error = () => {};
  node.status = () => {};
  RED.types["cip-endpoint"].call(node, {
    id: "ep",
    name: "sim",
    address: "127.0.0.1",
    port: TCP_PORT,
    slot: 0,
    connTimeout: 3000,
    keepAlive: 0,
    useMicro800,
    autoConnect: false,
  });
  await new Promise<void>((resolve, reject) =>
    node.connect((err: Error | null) => (err ? reject(err) : resolve()))
  );
  RED.endpoint = node;
  return node;
}

/** A node from `file` wired to RED.endpoint; input() resolves with what it sends. */
function makeNode(RED: any, file: string, type: string, config: Record<string, any>) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(path.join(NODES, file))(RED);
  const handlers: Record<string, any> = {};
  const node: any = Object.create(RED.types[type].prototype);
  node.status = () => {};
  node.log = () => {};
  node.warn = () => {};
  node.error = () => {};
  node.on = (ev: string, cb: any) => {
    handlers[ev] = cb;
  };
  node.emit = (ev: string, ...args: any[]) => handlers[ev]?.(...args);
  RED.types[type].call(node, { endpoint: "ep", ...config });
  return {
    input: (msg: Record<string, any>): Promise<any> =>
      new Promise((resolve) => {
        node.send = resolve;
        handlers.input(msg, resolve, () => undefined);
      }),
    close: () => handlers.close?.(() => undefined),
  };
}

describe.each([
  ["Logix, connected", "controllogix", false],
  ["Micro800, unconnected", "micro800", true],
])("%s", (_label, plcType, useMicro800) => {
  let sim: ChildProcess;
  let RED: any;
  let endpoint: any;

  beforeAll(async () => {
    sim = await startSim(plcType as string);
    RED = stubRED();
    endpoint = await makeEndpoint(RED, useMicro800 as boolean);
  }, 30000);

  afterAll(async () => {
    try {
      if (endpoint) {
        const giveUp = new Promise((r) => setTimeout(r, 2000).unref());
        await Promise.race([endpoint.disconnect(), giveUp]);
      }
    } finally {
      if (sim && !sim.killed) sim.kill("SIGKILL");
    }
  });

  it("endpoint.request() resolves with the reply", async () => {
    const reply: Buffer = await endpoint.request(GET_VENDOR);
    expect(reply.readUInt8(0)).toBe(0x8e);
    expect(reply.readUInt8(2)).toBe(0);
    expect(reply.length).toBeGreaterThan(4);
  });

  it("concurrent requests each get their own reply", async () => {
    const getName = Buffer.from([0x0e, 0x03, 0x20, 0x0f, 0x24, 0x01, 0x30, 0x07]);
    const [a, b] = await Promise.all([endpoint.request(GET_VENDOR), endpoint.request(getName)]);
    expect(a.readUInt8(0)).toBe(0x8e);
    expect(b.readUInt8(0)).toBe(0x8e);
    expect(b.equals(a)).toBe(false);
  });

  it("cip-raw gets the data back", async () => {
    const raw = makeNode(RED, "cip-raw.js", "cip-raw", {
      service: "0e",
      classId: "01",
      instanceId: "01",
      attributeId: "01",
    });
    const msg = await raw.input({});
    expect(msg.payload.success).toBe(true);
    expect(msg.payload.status).toBe(0);
    expect(msg.payload.data.length).toBeGreaterThan(0);
    raw.close();
  });

  it("cip-param reads a parameter with its value", async () => {
    const param = makeNode(RED, "cip-param.js", "cip-param", { paramInstance: 1 });
    const msg = await param.input({ command: "read" });
    expect(msg.payload.success).toBe(true);
    expect(msg.payload.name).toBe("Speed");
    expect(typeof msg.payload.value).toBe("number");
    expect(msg.payload.units).toBe("RPM");
    expect(msg.payload.readOnly).toBe(false);
    param.close();
  });

  it("cip-param reports a read-only parameter", async () => {
    const param = makeNode(RED, "cip-param.js", "cip-param", { paramInstance: 2 });
    const msg = await param.input({ command: "read" });
    expect(msg.payload.name).toBe("Temperature");
    expect(msg.payload.readOnly).toBe(true);
    param.close();
  });

  it("cip-param fails a read of a parameter that does not exist", async () => {
    const param = makeNode(RED, "cip-param.js", "cip-param", { paramInstance: 99 });
    const msg = await param.input({ command: "read" });
    expect(msg.payload.success).toBe(false);
    param.close();
  });
});
