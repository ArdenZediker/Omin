const fs = require('fs');
const iconv = require('iconv-lite');

const filePath = 'd:/AI-Coding/新建文件夹/omni/src/App.tsx';

// Read the raw bytes
const rawBuf = fs.readFileSync(filePath);

// Try to detect: read as GBK and check if it makes sense
const gbkText = iconv.decode(rawBuf, 'gbk');

// Check if GBK decode produces valid Chinese
const hasChineseGBK = /[\u4e00-\u9fff]/.test(gbkText);
console.log('GBK decode has Chinese:', hasChineseGBK);

if (hasChineseGBK) {
  // The file was saved as GBK by PowerShell, re-save as UTF-8
  fs.writeFileSync(filePath, gbkText, 'utf8');
  console.log('File re-saved as UTF-8 from GBK');
} else {
  console.log('GBK decode did not produce Chinese, trying other encodings...');
  // Try GB18030
  const gb18030Text = iconv.decode(rawBuf, 'gb18030');
  const hasChineseGB18030 = /[\u4e00-\u9fff]/.test(gb18030Text);
  console.log('GB18030 decode has Chinese:', hasChineseGB18030);
  
  if (hasChineseGB18030) {
    fs.writeFileSync(filePath, gb18030Text, 'utf8');
    console.log('File re-saved as UTF-8 from GB18030');
  } else {
    // The file might already be partially corrupted
    console.log('Could not recover Chinese text from encoding conversion');
    console.log('First 500 chars:', gbkText.substring(0, 500));
  }
}
