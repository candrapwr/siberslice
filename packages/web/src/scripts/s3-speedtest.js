// Diagnostik kecepatan server → S3. Jalankan di server: node packages/web/src/scripts/s3-speedtest.js [--mb 5]
// Ukur: (1) latensi DNS+TCP+TLS, (2) HeadBucket (latensi API), (3) PUT/GET (throughput), (4) GET presigned (jalur browser).
import { s3Configured } from "../config/env.js";
import { measureConnection } from "../server/s3-store.js";

// config/env.js (dimuat lewat import di atas) sudah membaca .env dari repo root.
async function main() {
  if (!s3Configured()) {
    console.error("S3 belum dikonfigurasi (bucket/access key/secret key). Jalankan dari repo dengan .env yang benar.");
    process.exit(1);
  }
  const mbIndex = process.argv.indexOf("--mb");
  const uploadMb = mbIndex >= 0 ? Number(process.argv[mbIndex + 1]) || 2 : 2;
  console.log(`Menguji koneksi ke S3 (${uploadMb} MB per uji)...`);
  const report = await measureConnection({ uploadMb });
  const lines = [];
  lines.push(`Endpoint : ${report.endpoint}  bucket: ${report.bucket}`);
  if (report.handshake.ip) {
    lines.push(`Handshake: DNS ${report.handshake.dnsMs}ms + TCP/TLS ${report.handshake.tcpTlsMs}ms = ${report.handshake.totalMs}ms (${report.handshake.host} → ${report.handshake.ip})`);
  } else {
    lines.push(`Handshake: ${report.handshake.skipped}`);
  }
  for (const check of report.checks) {
    lines.push(`${check.ok ? "✓" : "✗"} ${check.label.padEnd(38)} min ${check.minMs}ms / median ${check.medianMs}ms / max ${check.maxMs}ms${check.error ? `  ERROR ${check.error}` : ""}`);
  }
  lines.push(`Throughput: upload ${report.throughputEstimate.uploadMbpsMedian ?? "-"} Mbit/s, download ${report.throughputEstimate.downloadMbpsMedian ?? "-"} Mbit/s`);
  console.log(lines.join("\n"));
}

await main();
