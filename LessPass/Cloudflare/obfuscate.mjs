import fs from 'fs/promises';
import path from 'path';

// --- Configuration ---
const SOURCE_DIR = 'src';
const OUTPUT_DIR = 'dist';

// Defines the mapping of sensitive words to their replacements.
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

    // Use recursive option to find all files in all subdirectories
    // This will return paths relative to SOURCE_DIR, e.g., ['index.js', 'lib/utils.js']
    const allFiles = await fs.readdir(SOURCE_DIR, { recursive: true });

    // Filter to only include JavaScript files.
    const jsFiles = allFiles.filter((file) => file.endsWith('.js'));

    if (jsFiles.length === 0) {
      console.warn('No .js files found in the source directory.');
      return;
    }

    console.log(`Found ${jsFiles.length} JavaScript files to process.`);

    for (const fileRelativePath of jsFiles) {
      const sourcePath = path.join(SOURCE_DIR, fileRelativePath);
      const outputPath = path.join(OUTPUT_DIR, fileRelativePath);

      console.log(`Processing ${sourcePath}...`);

      // Ensure the parent directory exists in the output folder before writing
      const outputParentDir = path.dirname(outputPath);
      await fs.mkdir(outputParentDir, { recursive: true });

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
