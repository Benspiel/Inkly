/* Appwrite-Verbindung für Anmeldung und Profil („Meine Handschrift“).
 * Werte aus der Appwrite-Konsole eintragen (Einrichtung: siehe README, Abschnitt „Konten mit Appwrite“).
 * Bleibt projectId leer, ist die Anmeldung deaktiviert – der Rest von Inkly funktioniert weiter. */
window.INKLY_APPWRITE = {
  endpoint: "https://cloud.appwrite.io/v1", // z. B. https://fra.cloud.appwrite.io/v1
  projectId: "",                            // Projekt-ID aus der Appwrite-Konsole
  databaseId: "inkly",
  tableId: "handwriting",
};
