module.exports = async function handler(req, res) {
  try {
    const { runRoverUrlSync } = await import('../scripts/sync-rover-urls-lib.mjs');
    const result = await runRoverUrlSync({
      supabaseUrl: process.env.REACT_APP_SUPABASE_URL || process.env.SUPABASE_URL,
      supabaseSecretKey: process.env.SECRET_KEY_SUPABASE,
      headed: false,
      logger: console.log
    });

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
};