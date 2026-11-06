export function requireProvider(provider, label) {
  const missing = [];
  if (!provider?.baseUrl) missing.push("BASE_URL");
  if (!provider?.apiKey) missing.push("API_KEY");
  if (!provider?.model) missing.push("MODEL");
  if (missing.length) throw new Error(`${label} belum dikonfigurasi: ${missing.join(", ")}. Periksa file .env.`);
  try {
    new URL(provider.baseUrl);
  } catch {
    throw new Error(`${label} BASE_URL bukan URL yang valid.`);
  }
  return provider;
}
