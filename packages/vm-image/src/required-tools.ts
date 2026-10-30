/**
 * Machine-readable VM tool contract. Derived by rendering the default-skill
 * bundle, then auditing its shell fences, subprocess arguments, declared
 * preinstalled system dependencies, and Python imports.
 */
export const REQUIRED_TOOLS = {
  derivedFrom: 'packages/skills-registry rendered default-skill bundle',
  binaries: [
    {
      name: 'bunx',
      // `bunx --help` exits 1 (it wants a package arg); --version proves the
      // runnable binary without hitting the network.
      probe: 'bunx --version',
      skills: ['add-skill', 'create-skill', 'impeccable'],
    },
    {
      name: 'convert',
      probe: "convert --version 2>&1 | sed -n '1p'",
      skills: ['file-conversion'],
    },
    {
      name: 'curl',
      probe: "curl --version | sed -n '1p'",
      skills: ['add-skill', 'ai-gateway', 'media-creation', 'webhook-collector'],
    },
    {
      name: 'duet-browser',
      probe: 'test -x "$(command -v duet-browser)"',
      skills: ['workspace-browser'],
    },
    {
      name: 'ffmpeg',
      probe: "ffmpeg -version 2>&1 | sed -n '1p'",
      skills: ['file-conversion'],
    },
    { name: 'gh', probe: "gh --version | sed -n '1p'", skills: ['github'] },
    { name: 'git', probe: 'git --version', skills: ['impeccable'] },
    { name: 'gs', probe: 'gs --version', skills: ['pdf'] },
    { name: 'jq', probe: 'jq --version', skills: ['media-creation', 'webhook-collector'] },
    { name: 'node', probe: 'node --version', skills: ['impeccable'] },
    {
      name: 'pandoc',
      probe: "pandoc --version | sed -n '1p'",
      skills: ['file-conversion'],
    },
    { name: 'pdftotext', probe: "pdftotext -v 2>&1 | sed -n '1p'", skills: ['pdf'] },
    { name: 'python', probe: 'python --version', skills: ['add-skill', 'create-skill'] },
    {
      name: 'python3',
      probe: 'python3 --version',
      skills: ['create-skill', 'file-conversion', 'pdf', 'workspace-browser'],
    },
    { name: 'qpdf', probe: "qpdf --version 2>&1 | sed -n '1p'", skills: ['pdf'] },
    {
      name: 'soffice',
      probe: "soffice --headless --version | sed -n '1p'",
      skills: ['file-conversion'],
    },
    {
      name: 'static-web-server',
      probe: 'static-web-server --version',
      skills: ['build-apps'],
    },
    {
      name: 'tesseract',
      probe: "tesseract --version 2>&1 | sed -n '1p'",
      skills: ['pdf'],
    },
    { name: 'vips', probe: "vips --version 2>&1 | sed -n '1p'", skills: ['file-conversion'] },
  ],
  pythonModules: [
    { module: 'cairosvg', distribution: 'CairoSVG', skills: ['file-conversion'] },
    { module: 'docx', distribution: 'python-docx', skills: ['file-conversion'] },
    { module: 'markitdown', distribution: 'markitdown[all]', skills: ['file-conversion'] },
    { module: 'moviepy', distribution: 'moviepy<2', skills: ['file-conversion'] },
    { module: 'openpyxl', distribution: 'openpyxl', skills: ['file-conversion'] },
    { module: 'pandas', distribution: 'pandas', skills: ['pdf'] },
    { module: 'pdf2image', distribution: 'pdf2image', skills: ['pdf'] },
    { module: 'pdfplumber', distribution: 'pdfplumber', skills: ['pdf'] },
    { module: 'PIL', distribution: 'Pillow', skills: ['file-conversion', 'pdf'] },
    { module: 'pillow_heif', distribution: 'pillow-heif', skills: ['file-conversion'] },
    { module: 'playwright', distribution: 'playwright', skills: ['workspace-browser'] },
    { module: 'pptx', distribution: 'python-pptx', skills: ['file-conversion'] },
    { module: 'pypandoc', distribution: 'pypandoc', skills: ['file-conversion'] },
    { module: 'pypdf', distribution: 'pypdf', skills: ['pdf'] },
    { module: 'pytesseract', distribution: 'pytesseract', skills: ['pdf'] },
    { module: 'reportlab', distribution: 'reportlab', skills: ['pdf'] },
    { module: 'requests', distribution: 'requests', skills: ['pdf'] },
    { module: 'yaml', distribution: 'PyYAML', skills: ['create-skill'] },
  ],
} as const
