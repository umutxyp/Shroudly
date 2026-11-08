const fs = require('fs');
const path = require('path');

const iconPath = path.join(__dirname, '../public/icon.ico');
const smallIconPath = path.join(__dirname, '../public/icon.png');

if (!fs.existsSync(iconPath)) {
  console.error(`Missing Windows icon: ${iconPath}`);
  process.exit(1);
}

if (!fs.existsSync(smallIconPath)) {
  console.error(`Missing icon: ${smallIconPath}`);
  process.exit(1);
}

console.log('Existing icon assets verified.');
