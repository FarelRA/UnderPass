import fs from 'fs/promises';
import path from 'path';

// --- Configuration ---
const SOURCE_DIR = 'src';
const OUTPUT_DIR = 'dist';

const OBFUSCATION_MAP = {
  vless: 'vls',
  Vless: 'Vls',
  VLESS: 'VLS',
  tunnel: 'tnl',
  Tunnel: 'Tnl',
  TUNNEL: 'TNL',
  proxy: 'pry',
  Proxy: 'Pry',
  PROXY: 'PRY',
};

/**
 * Applies the obfuscation mapping to a given string.
 * This is used for both filenames and file content.
 * @param {string} inputString - The string to transform.
 * @returns {string} - The transformed string.
 */
function applyObfuscation(inputString) {
  let output = inputString;
  for (const [original, replacement] of Object.entries(OBFUSCATION_MAP)) {
    output = output.replaceAll(original, replacement);
  }
  return output;
}

/**
 * Main function to orchestrate the simplified obfuscation process.
 */
async function build() {
  console.log('Starting simplified obfuscation build process...');

  try {
    // Setup: Clean and create the output directory
    await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    // Recursively find all JavaScript files in the source directory
    const allFiles = await fs.readdir(SOURCE_DIR, { recursive: true });
    const jsFiles = allFiles.filter((file) => file.endsWith('.js'));

    console.log(`Found ${jsFiles.length} JavaScript files to process.`);

    for (const relativePath of jsFiles) {
      const sourcePath = path.join(SOURCE_DIR, relativePath);

      // 1. Determine the new, obfuscated destination path for the file
      const newRelativePath = applyObfuscation(relativePath);
      const outputPath = path.join(OUTPUT_DIR, newRelativePath);

      // 2. Read the original file content
      let content = await fs.readFile(sourcePath, 'utf8');

      // 3. Obfuscate the entire content in one go
      // This correctly handles variables, function names, and import paths
      content = applyObfuscation(content);

      // 4. Write the obfuscated content to the new destination path
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, content, 'utf8');

      console.log(`Processed: ${sourcePath}  ->  ${outputPath}`);
    }

    console.log('\n✅ Obfuscation build complete.');
  } catch (error) {
    console.error('\n❌ Build process failed:', error);
    process.exit(1);
  }
}

build();
