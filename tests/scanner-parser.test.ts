import assert from "node:assert/strict";
import test from "node:test";

import { parseScannerList } from "../lib/server/scanner";

test("parses scanimage -L output with closing apostrophe", () => {
  const output =
    "device `net:10.2.1.103:hpaio:/usb/HP_LaserJet_MFP_M129-M134?serial=VNFVY57093' is a Hewlett-Packard HP_LaserJet_MFP_M129-M134 all-in-one";

  const scanners = parseScannerList(output);
  assert.equal(scanners.length, 1);
  assert.equal(scanners[0].deviceId, "net:10.2.1.103:hpaio:/usb/HP_LaserJet_MFP_M129-M134?serial=VNFVY57093");
  assert.equal(scanners[0].description, "a Hewlett-Packard HP_LaserJet_MFP_M129-M134 all-in-one");
});

test("parses scanimage -L output with closing backtick", () => {
  const output = "device `hpaio:/usb/HP_LaserJet_MFP_M129-M134?serial=VNFVY57093` is a Hewlett-Packard HP all-in-one";

  const scanners = parseScannerList(output);
  assert.equal(scanners.length, 1);
  assert.equal(scanners[0].deviceId, "hpaio:/usb/HP_LaserJet_MFP_M129-M134?serial=VNFVY57093");
});

test("parses scanimage -L output with single quotes", () => {
  const output = "device 'escl:http://10.2.1.103:8080' is a HP Network Scanner";

  const scanners = parseScannerList(output);
  assert.equal(scanners.length, 1);
  assert.equal(scanners[0].deviceId, "escl:http://10.2.1.103:8080");
  assert.equal(scanners[0].description, "a HP Network Scanner");
});

test("ignores noise lines and keeps valid device lines", () => {
  const output = [
    "Created directory: /var/lib/snmp/cert_indexes",
    "device `net:10.2.1.103:hpaio:/usb/HP_LaserJet_MFP_M129-M134?serial=VNFVY57093' is a Hewlett-Packard HP scanner",
    "Some backend warning"
  ].join("\n");

  const scanners = parseScannerList(output);
  assert.equal(scanners.length, 1);
  assert.equal(scanners[0].deviceId, "net:10.2.1.103:hpaio:/usb/HP_LaserJet_MFP_M129-M134?serial=VNFVY57093");
});
