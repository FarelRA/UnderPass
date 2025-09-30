import fs from 'fs/promises';
import path from 'path';

// --- Configuration ---
const SOURCE_DIR = 'src';
const OUTPUT_DIR = 'dist';

// Defines the mapping of sensitive words to their replacements.
// We use thematic but neutral synonyms to maintain some readability if needed.
const OBFUSCATION_MAP = {
  vless: 'passage',
  VLESS: 'Passage',
  proxy: 'conduit',
  Proxy: 'Conduit',
  tunnel: 'channel',
  Tunnel: 'Channel',
};

/**
 * Main function to orchestrate the obfuscation process.
 */
async function build() {
  console.log('Starting obfuscation build process...');

  try {
    // Ensure the output directory exists and is clean
    await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    const files = await fs.readdir(SOURCE_DIR);

    for (const file of files) {
      if (!file.endsWith('.js')) continue; // Only process JavaScript files

      const sourcePath = path.join(SOURCE_DIR, file);
      const outputPath = path.join(OUTPUT_DIR, file);

      console.log(`Processing ${sourcePath}...`);

      let content = await fs.readFile(sourcePath, 'utf8');

      // Apply all replacements from the map
      for (const [original, replacement] of Object.entries(OBFUSCATION_MAP)) {
        // Use replaceAll to catch all occurrences in the file
        content = content.replaceAll(original, replacement);
      }

      await fs.writeFile(outputPath, content, 'utf8');
      console.log(`  -> Wrote obfuscated file to ${outputPath}`);
    }

    console.log('\n✅ Obfuscation build complete.');
  } catch (error) {
    console.error('\n❌ Build process failed:', error);
    process.exit(1); // Exit with an error code
  }
}

build();
