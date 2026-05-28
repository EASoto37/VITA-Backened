const http = require('http');
const fs = require('fs');
const path = require('path');

const FOLDER = path.join(require('os').homedir(), 'Downloads');

http.createServer((req, res) => {
  res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  let fileName = req.url === '/' ? 'vita_dashboard.html' : req.url.replace('/','');
  let filePath = path.join(FOLDER, fileName);

  fs.readFile(filePath, (err, data) => {
    if(err){
      console.log('File not found:', filePath);
      res.writeHead(404);
      res.end('Not found: ' + filePath);
      return;
    }
    const ext = path.extname(filePath);
    const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css'};
    res.writeHead(200, {'Content-Type': types[ext]||'text/plain'});
    res.end(data);
  });
}).listen(3000, () => {
  console.log('VITA running at http://localhost:3000');
  console.log('Serving files from:', FOLDER);
});
