import { writeFileSync,existsSync,mkdirSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assert } from '../src/config.mjs';
async function masked(label) {
  assert(process.stdin.isTTY,'Run in an interactive terminal; never send secrets in chat');
  process.stderr.write(label+': ');process.stdin.setRawMode(true);process.stdin.resume();
  return new Promise((resolve,reject)=>{
    let value='';
    function done(error){process.stdin.off('data',onData);process.stdin.setRawMode(false);process.stdin.pause();process.stderr.write('\n');error?reject(error):resolve(value);}
    function onData(chunk){for(const char of chunk.toString()){if(char==='\u0003'){done(new Error('Cancelled'));return;}if(char==='\r'||char==='\n'){done();return;}if(char==='\u007f'||char==='\b'){value=value.slice(0,-1);}else if(char>=' ')value+=char;}}
    process.stdin.on('data',onData);
  });
}
try {
  const file=resolve(process.argv[2]??'');assert(process.argv[2],'Usage: node scripts/init-env.mjs /private/path/.env');assert(!existsSync(file),'Refusing to overwrite existing env');
  const app=await masked('Meta App Secret'),page=await masked('Page Access Token');
  assert(app.length>=16&&page.length>=16,'Missing/short credential');
  assert(!/[\r\n]/.test(app+page),'Invalid credential');
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  writeFileSync(file,`META_APP_SECRET=${JSON.stringify(app)}
META_PAGE_ACCESS_TOKEN=${JSON.stringify(page)}
META_WEBHOOK_VERIFY_TOKEN=${randomBytes(24).toString('hex')}
CSKH_ADMIN_TOKEN=${randomBytes(32).toString('hex')}
TELEGRAM_BOT_TOKEN=

PAGE_CSKH_PAGE_ID=
PAGE_CSKH_APP_ID=
PAGE_CSKH_PAGE_NAME=
PAGE_CSKH_PUBLIC_WEBHOOK_URL=
PAGE_CSKH_MODEL=
PAGE_CSKH_AGENT_ID=page-cskh
PAGE_CSKH_GRAPH_VERSION=v25.0
PAGE_CSKH_WEBHOOK_PATH=/webhooks/page-cskh
PAGE_CSKH_ADMIN_PORT=18891
PAGE_CSKH_EDGE_PORT=18892
PAGE_CSKH_ENV_FILE=./.env
PAGE_CSKH_DATABASE=./data/page.sqlite
PAGE_CSKH_WORKSPACE=./agent
PAGE_CSKH_KNOWLEDGE_FILE=./knowledge.json
PAGE_CSKH_MODE=draft
PAGE_CSKH_WAITING_RESET_SECONDS=0
PAGE_CSKH_MESSAGE_DEBOUNCE_SECONDS=2
PAGE_CSKH_ENABLE_HUMAN_HANDOFF=true
PAGE_CSKH_ORDER_TELEGRAM_CHAT_IDS=[]
PAGE_CSKH_SCOPE_DESCRIPTION=Chỉ tư vấn dịch vụ, sản phẩm và chính sách của Page này.
PAGE_CSKH_SCOPE_KEYWORDS=đặt hàng,giá,sản phẩm,chính sách
PAGE_CSKH_HANDOFF_TEXT=Em chuyển nhân viên hỗ trợ tiếp nhé.
PAGE_CSKH_OUT_OF_SCOPE_TEXT=Em chỉ hỗ trợ thông tin dịch vụ và sản phẩm của Page này ạ.
PAGE_CSKH_CLARIFY_TEXT=Anh/chị muốn tìm hiểu sản phẩm hoặc dịch vụ nào của bên em ạ?
PAGE_CSKH_MAX_DAILY_AGENT_CALLS=200
PAGE_CSKH_MAX_CUSTOMER_CALLS_PER_HOUR=20
PAGE_CSKH_AGENT_TIMEOUT_MS=45000
`,{mode:0o600,flag:'wx'});
  console.log('Created private env file. Fill PAGE_CSKH_* values, then run npm run generate-config. Verify/admin tokens generated locally; inspect only in your private terminal/editor.');
}catch(e){console.error(e.message);process.exitCode=1;}
