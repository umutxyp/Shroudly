// Script to fix paths in built HTML files for Electron
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '../out');
const files = ['index.html', '404.html'];

files.forEach(file => {
  const filePath = path.join(outDir, file);
  
  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Replace absolute paths with relative paths
    content = content.replace(/href="\/_next/g, 'href="./_next');
    content = content.replace(/src="\/_next/g, 'src="./_next');
    content = content.replace(/href="\/icon/g, 'href="./icon');
    content = content.replace(/src="\/icon/g, 'src="./icon');
    content = content.replace(/href="\/logo/g, 'href="./logo');
    content = content.replace(/src="\/logo/g, 'src="./logo');
    content = content.replace(/href="\/tray/g, 'href="./tray');
    content = content.replace(/src="\/tray/g, 'src="./tray');
    
    // Fix assetPrefix in inline scripts
    content = content.replace(/"assetPrefix":""/g, '"assetPrefix":"."');
    content = content.replace(/\\"assetPrefix\\":\\"\\"/g, '\\"assetPrefix\\":\\"..\\"');
    
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✅ Fixed paths in ${file}`);
  }
});

console.log('🎉 All paths fixed!');
