/* Inkly – Konto löschen.
 *
 * Wird vom angemeldeten Benutzer über „Konto löschen“ im Profil aufgerufen. Appwrite setzt dabei
 * den Header x-appwrite-user-id auf den aufrufenden Benutzer – gelöscht wird immer nur dieses
 * eine Konto. Die Function braucht die API-Rechte (Scopes) users.write und rows.write
 * (Einrichtung: siehe README, Abschnitt „Konto löschen“).
 *
 * Bewusst ohne Abhängigkeiten (nur node:https/node:http), damit sie ohne Build-Schritt und
 * auf jeder Node.js-Runtime ab Version 16 läuft.
 *
 * Umgebungsvariablen:
 *   INKLY_DATABASE_ID  – ID der Datenbank mit der Handschrift-Tabelle
 *   INKLY_TABLE_ID     – ID der Handschrift-Tabelle
 */
const http = require("http");
const https = require("https");

function appwrite(method, path, key) {
  const url = new URL(process.env.APPWRITE_FUNCTION_API_ENDPOINT.replace(/\/$/, "") + path);
  const lib = url.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method,
      headers: {
        "content-type": "application/json",
        "x-appwrite-project": process.env.APPWRITE_FUNCTION_PROJECT_ID,
        "x-appwrite-key": key,
      },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

module.exports = async ({ req, res, log, error }) => {
  const userId = req.headers["x-appwrite-user-id"];
  if (!userId) return res.json({ ok: false, message: "Nicht angemeldet." }, 401);

  const key = req.headers["x-appwrite-key"] || process.env.APPWRITE_API_KEY || "";
  const enc = encodeURIComponent;

  try {
    // 1. Handschrift löschen (fehlt sie, ist das kein Fehler)
    const row = await appwrite("DELETE",
      `/tablesdb/${enc(process.env.INKLY_DATABASE_ID)}/tables/${enc(process.env.INKLY_TABLE_ID)}/rows/${enc(userId)}`, key);
    if (row.status >= 300 && row.status !== 404) throw new Error(`Handschrift: ${row.status} ${row.body}`);

    // 2. Konto samt Sitzungen löschen
    const user = await appwrite("DELETE", `/users/${enc(userId)}`, key);
    if (user.status >= 300) throw new Error(`Konto: ${user.status} ${user.body}`);

    log(`Konto ${userId} gelöscht.`);
    return res.json({ ok: true });
  } catch (e) {
    error(`Löschen von ${userId} fehlgeschlagen: ${e.message}`);
    return res.json({ ok: false, message: "Konto konnte nicht gelöscht werden." }, 500);
  }
};
