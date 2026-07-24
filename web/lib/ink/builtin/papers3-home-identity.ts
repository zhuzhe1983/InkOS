/**
 * Browser-safe identity for the built-in PaperS3 application-home package.
 *
 * Keep these values separate from the package builder because the browser
 * client needs the download URL without pulling Node-only rendering code into
 * its bundle.
 */
export const PAPERS3_HOME_PACKAGE_ID = "7f12227f-be7f-5092-a73f-6dc57e85af61";
export const PAPERS3_HOME_ENTRY_UUID = "f67a9105-45db-5a99-af84-f07d1ba1ebce";

export const PAPERS3_HOME_DOWNLOAD_URL =
  `/api/ink/v1/packages/${PAPERS3_HOME_PACKAGE_ID}/download`;

export const PAPERS3_HOME_DEMO_FILENAME = "inkos-papers3-home-demo.ink";
