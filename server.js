// Stable entry for Hostinger's default `node server.js` launch command.
process.env.NODE_ENV ||= "production";

try {
  const { startHostingerServer } = await import("./dist/hostinger.js");
  await startHostingerServer();
} catch (error) {
  console.error(error);
  process.exit(1);
}
