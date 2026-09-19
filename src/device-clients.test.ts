import assert from "node:assert/strict";
import test from "node:test";

import { describeHidDevice } from "./hid-diagnostics.ts";
import { createSupportedClient } from "./device-clients.ts";

test("HID diagnostics include device IDs and report collections", () => {
  const device = {
    productName: "Example Mouse",
    vendorId: 0x1234,
    productId: 0xabcd,
    collections: [{
      usagePage: 0xff00,
      usage: 1,
      featureReports: [{ reportId: 7 }],
    }],
  } as unknown as HIDDevice;

  assert.equal(
    describeHidDevice(device),
    "Example Mouse (VID 0x1234 PID 0xabcd; usage 0xff00:1 feat[0x7])",
  );
});

test("native Bridge exposes Razer transports without widening WebHID", () => {
  const products = [
    { productName: "Razer Viper Ultimate", productId: 0x007b },
    { productName: "Razer DeathAdder V3 HyperSpeed", productId: 0x00c5 },
    { productName: "Razer Viper V4 Pro", productId: 0x00e5 },
  ];

  for (const product of products) {
    const browserDevice = {
      ...product,
      vendorId: 0x1532,
      collections: [],
      opened: false,
    } as unknown as HIDDevice;
    const bridgeDevice = {
      ...browserDevice,
      openMouseTransport: "bridge",
    } as unknown as HIDDevice;

    assert.equal(createSupportedClient(browserDevice), null);
    assert.notEqual(createSupportedClient(bridgeDevice), null);
  }
});
