// profile.js — Local [TOKEN] -> real value substitution store.
// Uses chrome.storage.local. Per the prompt, default profile:

const DEFAULT_PROFILE = {
  "[NAME]": "Asha Verma",
  "[EMAIL]": "asha.verma@example.org",
  "[PHONE]": "+91 90000 11111",
  "[AADHAAR]": "2345 1234 5123",
  "[CARD]": "4012 8888 8888 1881",
  "[PASSWORD]": "Demo@12345",
};

const STORAGE_KEY = "pg_profile";

export async function getProfile() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      const stored = result[STORAGE_KEY] || {};
      resolve({ ...DEFAULT_PROFILE, ...stored });
    });
  });
}

export async function setProfile(updates) {
  const current = await getProfile();
  const merged = { ...current, ...updates };
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: merged }, () => resolve(merged));
  });
}

export async function resolveToken(token) {
  const profile = await getProfile();
  return profile[token] ?? token;
}

export async function resolveValue(value, substitutionMap) {
  if (!value) return value;
  if (/^\[[A-Z_]+\]$/.test(value)) {
    if (substitutionMap && substitutionMap[value]) {
      return substitutionMap[value];
    }
    return await resolveToken(value);
  }
  return value;
}

export { DEFAULT_PROFILE };
