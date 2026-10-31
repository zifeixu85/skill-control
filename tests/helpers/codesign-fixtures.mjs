import { createHash } from "node:crypto";

/** codesign and certificate fixtures shared by the signing-hook and updater tests. */

export const CERT_SHA1 = "313A65FF9080E447216EBC2C090344785D2652B1";
export const DER = Buffer.from("fixture certificate DER");
export const DER_SHA1 = createHash("sha1").update(DER).digest("hex").toUpperCase();

/** Real `codesign -d -r- --verbose=4` output of an ad-hoc build (stderr, then stdout). */
export const ADHOC_DISPLAY = `Executable=/tmp/Skill Control.app/Contents/MacOS/Skill Control
Identifier=dev.skillcontrol.desktop
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=443 flags=0x2(adhoc) hashes=3+7 location=embedded
CDHash=a53def63b68c67fab80392a01dc51b790bf64f1e
Signature=adhoc
Info.plist entries=32
TeamIdentifier=not set
Sealed Resources version=2 rules=13 files=13
# designated => cdhash H"a53def63b68c67fab80392a01dc51b790bf64f1e"
`;

/** The same for a build signed with the self-signed certificate. */
export const certDisplay = ({ hash = CERT_SHA1.toLowerCase(), cdhash = "0123456789abcdef0123456789abcdef01234567", identifier = "dev.skillcontrol.desktop" } = {}) =>
  `Executable=/tmp/Skill Control.app/Contents/MacOS/Skill Control
Identifier=${identifier}
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=443 flags=0x0(none) hashes=3+7 location=embedded
CDHash=${cdhash}
Signature size=1683
Authority=Skill Control Code Signing (zifeixu85)
Signed Time=Nov 1, 2026 at 03:00:00
Info.plist entries=32
TeamIdentifier=not set
Sealed Resources version=2 rules=13 files=13
Internal requirements count=1 size=124
designated => identifier "${identifier}" and certificate leaf = H"${hash}"
`;
