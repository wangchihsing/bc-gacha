// 讀寫私人儲存庫裡的進度檔（GitHub Contents API）
// 鑰匙只存在這支手機的瀏覽器裡，不寫進程式碼

export const REPO = "wangchihsing/bc-gacha-data";
export const FILE = "progress.json";
const API = `https://api.github.com/repos/${REPO}/contents/`;

export class ConflictError extends Error {}
export class AuthError extends Error {}

const toBase64 = text => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromBase64 = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), c => c.charCodeAt(0)));

async function call(token, path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (res.status === 401 || res.status === 403) throw new AuthError("鑰匙無效、過期，或沒有這個儲存庫的讀寫權限");
  if (res.status === 409 || res.status === 422) throw new ConflictError("進度在別的地方被改過");
  if (!res.ok) throw new Error(`GitHub 回應 ${res.status}`);
  return res.json();
}

// 回傳 { data, sha }
export async function load(token, file = FILE) {
  const body = await call(token, file);
  return { data: JSON.parse(fromBase64(body.content)), sha: body.sha };
}

// sha 是讀進來時的版本；別處先改過會丟 ConflictError，不會蓋掉
export async function save(token, data, sha, message, file = FILE) {
  const body = await call(token, file, {
    method: "PUT",
    body: JSON.stringify({ message, content: toBase64(JSON.stringify(data, null, 2) + "\n"), sha }),
  });
  return body.content.sha;
}
