/* Inkly – Konto löschen.
 *
 * Wird vom angemeldeten Benutzer über „Konto löschen“ im Profil aufgerufen. Appwrite setzt dabei
 * den Header x-appwrite-user-id auf den aufrufenden Benutzer – gelöscht wird immer nur dieses
 * eine Konto. Die Function braucht die API-Rechte users.write und rows.write
 * (Einrichtung: siehe README, Abschnitt „Konto löschen“).
 *
 * Umgebungsvariablen:
 *   INKLY_DATABASE_ID  – ID der Datenbank mit der Handschrift-Tabelle
 *   INKLY_TABLE_ID     – ID der Handschrift-Tabelle
 */
import { Client, Users, TablesDB } from "node-appwrite";

export default async ({ req, res, log, error }) => {
  const userId = req.headers["x-appwrite-user-id"];
  if (!userId) return res.json({ ok: false, message: "Nicht angemeldet." }, 401);

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers["x-appwrite-key"] || process.env.APPWRITE_API_KEY || "");

  try {
    // 1. Handschrift löschen (fehlt sie, ist das kein Fehler)
    try {
      await new TablesDB(client).deleteRow({
        databaseId: process.env.INKLY_DATABASE_ID,
        tableId: process.env.INKLY_TABLE_ID,
        rowId: userId,
      });
    } catch (e) {
      if (e.code !== 404) throw e;
    }
    // 2. Konto samt Sitzungen löschen
    await new Users(client).delete({ userId });
    log(`Konto ${userId} gelöscht.`);
    return res.json({ ok: true });
  } catch (e) {
    error(`Löschen von ${userId} fehlgeschlagen: ${e.message}`);
    return res.json({ ok: false, message: "Konto konnte nicht gelöscht werden." }, 500);
  }
};
