import { generateVapidKeys } from "../src/app/web-push.js";

// Prints a new VAPID key pair for the server's .env. Keep the private key secret; changing the pair makes every
// device subscribe again.
const { publicKey, privateKey } = generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\nVAPID_SUBJECT=mailto:you@example.com`);
