/* Appwrite-Verbindung für Anmeldung und Profil („Meine Handschrift“).
 * Werte aus der Appwrite-Konsole eintragen (Einrichtung: siehe README, Abschnitt „Konten mit Appwrite“).
 * Bleibt projectId leer, ist die Anmeldung deaktiviert – der Rest von Inkly funktioniert weiter. */
window.INKLY_APPWRITE = {
  endpoint: "https://appwrite.buchholz.dev/v1",
  projectId: "6ae850330009b4ce35f1",
  databaseId: "6ae854a1002895208cfc",
  tableId: "6ae854bd002ded65bf10",
  deleteFunctionId: "delete-account", // Appwrite Function für „Konto löschen“ (appwrite/functions/delete-account)
};
