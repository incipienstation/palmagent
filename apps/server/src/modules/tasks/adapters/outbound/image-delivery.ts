import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { imageDeliveryPath, INPUT_IMAGE_POLICY, type DeliveredImage, type DispatchSessionRequest } from "@palmagent/shared";
import { DeliveredImageSchema } from "@palmagent/shared/requests";
import { rasterMediaType } from "../../application/attachments/output-images.js";

type Session = Omit<DispatchSessionRequest, "waitPid">;
const encodedLimit = Math.ceil(INPUT_IMAGE_POLICY.maxBytes / 3) * 4 + 32 * 1024;
const stagingLifetime = 24 * 60 * 60 * 1000;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

// The Linux agent sandbox and Task owner share this temporary directory. No
// command socket, task checkout or caller-selected source is opened by the owner.
function withDirectory<T>(create: boolean, run: (directory: string) => T): T | undefined {
  const root = `/tmp/palmagent-image-deliveries-${process.getuid!()}`;
  if (create) {
    try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  let fd: number;
  try { fd = openSync(root, constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error) { if (!create && missing(error)) return; throw error; }
  try {
    const stat = fstatSync(fd);
    if (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw new Error("Unsafe image handoff directory");
    return run(`/proc/self/fd/${fd}`);
  } finally { closeSync(fd); }
}

function sessionKey(session: Session) {
  return createHash("sha256").update(JSON.stringify([session.agent, session.sessionId, realpathSync(session.cwd), realpathSync(session.home)])).digest("hex");
}

function readBytes(fd: number, limit: number): Buffer {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.size > limit) throw new Error("Image handoff file exceeds the size limit or is not a regular file");
  const bytes = Buffer.alloc(stat.size + 1);
  let length = 0;
  while (length < bytes.length) {
    const count = readSync(fd, bytes, length, bytes.length - length, null);
    if (!count) break;
    length += count;
  }
  if (length !== stat.size) throw new Error("Image changed during delivery");
  return bytes.subarray(0, length);
}

export function stageImageFile(session: Session, path: string) {
  const source = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let bytes: Buffer;
  try { bytes = readBytes(source, INPUT_IMAGE_POLICY.maxBytes); } finally { closeSync(source); }
  const mediaType = rasterMediaType(bytes);
  if (!mediaType) throw new Error("Image delivery supports PNG, JPEG, GIF and WebP");
  const delivery = DeliveredImageSchema.parse({ path, image: { mediaType, data: bytes.toString("base64") } });
  const receipt = randomUUID(), key = sessionKey(session);
  withDirectory(true, root => {
    const name = join(root, `${key}.${receipt}`);
    const fd = openSync(name, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ key, receipt, delivery })); fsyncSync(fd); }
    catch (error) { unlinkSync(name); throw error; }
    finally { closeSync(fd); }
  });
  return { receipt, path: imageDeliveryPath(receipt, mediaType) };
}

export function claimImageDelivery(session: Session, receipt: string, save: (delivery: DeliveredImage, link: string) => void) {
  if (!/^[0-9a-f-]{36}$/.test(receipt)) throw new Error("Invalid image receipt");
  let key: string;
  try { key = sessionKey(session); } catch (error) { if (missing(error)) return; throw error; }
  withDirectory(false, root => {
    const path = join(root, `${key}.${receipt}`);
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (missing(error)) return; throw error; }
    try {
      const stat = fstatSync(fd);
      if (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1) throw new Error("Unsafe image handoff file");
      const value = JSON.parse(readBytes(fd, encodedLimit).toString("utf8"));
      if (value.key !== key || value.receipt !== receipt) throw new Error("Image receipt does not match this session");
      const delivery = DeliveredImageSchema.parse(value.delivery);
      save(delivery, imageDeliveryPath(receipt, delivery.image.mediaType));
      // A crash before unlink can replay safely through content and path deduplication.
      try { unlinkSync(path); } catch (error) { if (!missing(error)) throw error; }
    } finally { closeSync(fd); }
  });
}

export function pruneImageDeliveries(now: number) {
  withDirectory(false, root => {
    for (const name of readdirSync(root)) {
      if (!/^[0-9a-f]{64}\.[0-9a-f-]{36}$/.test(name)) continue;
      const path = join(root, name);
      try { if (lstatSync(path).mtimeMs < now - stagingLifetime) unlinkSync(path); }
      catch (error) { if (!missing(error)) throw error; }
    }
  });
}
