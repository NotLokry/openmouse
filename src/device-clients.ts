import {
  eggWeMergeLogicalDevices,
} from "@openmouse/protocol/drivers/endgame/egg-we-control";
import { collapseBoltPeers } from "@openmouse/protocol/drivers/logitech/bolt";
import {
  COBRA_PRODUCT_ID,
  RazerCobraHidClient,
} from "@openmouse/protocol/drivers/razer/cobra-hid";
import { RazerHidClient } from "@openmouse/protocol/drivers/razer/hid";
import {
  RazerViperHidClient,
  VIPER_PRODUCT_ID,
} from "@openmouse/protocol/drivers/razer/viper-hid";
import {
  RazerViperMiniHidClient,
  VIPER_MINI_PRODUCT_ID,
} from "@openmouse/protocol/drivers/razer/viper-mini-hid";
import {
  RazerViperV4ProHidClient,
  VIPER_V4_PRO_PRODUCTS,
} from "@openmouse/protocol/drivers/razer/viper-v4-pro-hid";
import {
  clientSupportScore as registryClientSupportScore,
  createSupportedClient as registryCreateSupportedClient,
  deviceBrand,
  type PulsarClient,
  type SupportedClient,
} from "@openmouse/protocol/drivers/registry";
import { RAZER_PRODUCTS } from "@openmouse/protocol/razer-devices";
export { describeHidDevice } from "./hid-diagnostics.ts";
export { deviceBrand, type PulsarClient, type SupportedClient };

type NativeBridgeDevice = HIDDevice & { openMouseTransport?: "bridge" };


function bridgeRazerClient(device: HIDDevice): SupportedClient | null {
  if ((device as NativeBridgeDevice).openMouseTransport !== "bridge"
    || device.vendorId !== 0x1532) return null;
  if (VIPER_V4_PRO_PRODUCTS.has(device.productId)) return new RazerViperV4ProHidClient(device);
  if (device.productId === COBRA_PRODUCT_ID) return new RazerCobraHidClient(device);
  if (device.productId === VIPER_PRODUCT_ID) return new RazerViperHidClient(device);
  if (device.productId === VIPER_MINI_PRODUCT_ID) return new RazerViperMiniHidClient(device);
  if (RAZER_PRODUCTS.has(device.productId)) return new RazerHidClient(device);
  return null;
}


export function createSupportedClient(device: HIDDevice): SupportedClient | null {
  return registryCreateSupportedClient(device) ?? bridgeRazerClient(device);
}

export function clientSupportScore(device: HIDDevice): number {
  return bridgeRazerClient(device) !== null ? 10_000 : registryClientSupportScore(device);
}

/** Supported devices for the sidebar; multi-path drivers collapse via their module. */
export function listLogicalDevices(devices: HIDDevice[] = []): HIDDevice[] {
  const afterEgg = eggWeMergeLogicalDevices(devices, (device) => createSupportedClient(device) !== null);
  return collapseBoltPeers(afterEgg);
}
