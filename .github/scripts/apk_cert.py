"""Print the sha256 of the certificate an APK is signed with (v2 scheme).

Used by the APK workflow to prove the build used the stable signing key: a
different key means Android will refuse to install the APK over an installed
copy of the app, which is invisible until someone tries to update.
"""

import hashlib
import struct
import sys


def cert_sha256(path: str) -> str:
    data = open(path, "rb").read()
    eocd = data.rfind(b"PK\x05\x06")
    cd_off = struct.unpack("<I", data[eocd + 16 : eocd + 20])[0]
    if data[cd_off - 16 : cd_off] != b"APK Sig Block 42":
        raise SystemExit("apk has no v2 signing block")
    size = struct.unpack("<Q", data[cd_off - 24 : cd_off - 16])[0]
    block = data[cd_off - size : cd_off - 16]

    def u32(b: bytes, o: int) -> int:
        return struct.unpack("<I", b[o : o + 4])[0]

    pos = 0
    while pos + 12 <= len(block):
        length = struct.unpack("<Q", block[pos : pos + 8])[0]
        if struct.unpack("<I", block[pos + 8 : pos + 12])[0] == 0x7109871A:
            val = block[pos + 12 : pos + 8 + length]
            signers = val[4 : 4 + u32(val, 0)]
            signer = signers[4 : 4 + u32(signers, 0)]
            signed = signer[4 : 4 + u32(signer, 0)]
            off = 4 + u32(signed, 0)  # skip digests
            certs = signed[off + 4 : off + 4 + u32(signed, off)]
            return hashlib.sha256(certs[4 : 4 + u32(certs, 0)]).hexdigest()
        pos += 8 + length
    raise SystemExit("no v2 signer found in the signing block")


if __name__ == "__main__":
    print(cert_sha256(sys.argv[1]))
