import { errorText } from "./utils.js";
let csrf = "";
export function setCsrf(value) {
  csrf = typeof value === "string" ? value : "";
}
export async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 30000);
  try {
    const response = await fetch(`/api/astra${path}`, {
      method: options.method || "GET",
      credentials: "same-origin",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...(options.method && options.method !== "GET"
          ? { "X-CSRF-Token": csrf }
          : {}),
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    });
    const json = await response
      .json()
      .catch(() => ({ detail: `HTTP ${response.status}` }));
    if (!response.ok) {
      const error = new Error(errorText(json.detail || json.error || json));
      error.status = response.status;
      throw error;
    }
    return json;
  } catch (error) {
    if (error.name === "AbortError")
      throw new Error(
        "応答に時間がかかっています。システム状態を確認してから再試行してください。",
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
