/* ---- art direction for the sprite-sheet preview ---- */
const PAL=['#ff5b34','#ff9f68','#3ddc97','#9ca8d0','#ffbf69','#6ca6d8','#d37abe','#76b8a1'];

function updateModalLock(){
  document.body.classList.toggle('modal-open',Boolean(document.querySelector('.overlay.open')));
}

/* ---- Project Lab popup ---- */
(() => {
  const overlay = document.getElementById('labOverlay');
  const openButton = document.getElementById('openLab');
  if (!overlay || !openButton) return;

  const closeButtons = [document.getElementById('labClose'), document.getElementById('labDismiss')];
  const open = () => {
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    updateModalLock();
    document.getElementById('labClose')?.focus();
  };
  const close = () => {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    updateModalLock();
    try { sessionStorage.setItem('siberslice_project_lab_seen', '1'); } catch {}
  };

  openButton.addEventListener('click', open);
  closeButtons.forEach((button) => button?.addEventListener('click', close));
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && overlay.classList.contains('open')) close();
  });

  let alreadySeen = false;
  try { alreadySeen = sessionStorage.getItem('siberslice_project_lab_seen') === '1'; } catch {}
  if (!alreadySeen) window.setTimeout(open, 700);
})();

/* shape svg (for cells) */
function svgShape(type,color){
  const ink='#0c0d11';
  const wrap=(inner)=>`<svg viewBox="0 0 100 100">${inner}</svg>`;
  const S=(t,at)=>`<${t} ${at} fill="${color}" stroke="${ink}" stroke-width="5" stroke-linejoin="round"/>`;
  if(type==='gem')return wrap(S('polygon',{points:'50,10 85,35 70,88 30,88 15,35'}));
  if(type==='coin')return wrap(S('circle',{cx:50,cy:50,r:38})+`<circle cx="50" cy="50" r="22" fill="none" stroke="${ink}" stroke-width="5"/>`);
  if(type==='heart')return wrap(S('path',{d:'M50 84 C18 56 26 24 50 40 C74 24 82 56 50 84 Z'}));
  if(type==='star')return wrap(S('polygon',{points:'50,10 61,38 92,38 67,57 76,88 50,69 24,88 33,57 8,38 39,38'}));
  if(type==='potion')return wrap(`<rect x="36" y="16" width="28" height="12" fill="${ink}"/><rect x="42" y="22" width="16" height="30" fill="${color}" stroke="${ink}" stroke-width="4"/><circle cx="50" cy="66" r="26" fill="${color}" stroke="${ink}" stroke-width="5"/>`);
  if(type==='leaf')return wrap(S('path',{d:'M50 12 C84 40 84 74 50 90 C16 74 16 40 50 12 Z'}));
  if(type==='bolt')return wrap(S('polygon',{points:'58,8 24,56 46,56 40,92 78,40 54,40'}));
  if(type==='hex')return wrap(S('polygon',{points:'50,12 84,32 84,68 50,88 16,68 16,32'}));
  if(type==='badge')return wrap(S('polygon',{points:'50,10 74,22 84,46 74,70 50,82 26,70 16,46 26,22'}));
  if(type==='key')return wrap(`<circle cx="40" cy="34" r="20" fill="${color}" stroke="${ink}" stroke-width="5"/><line x1="52" y1="48" x2="82" y2="78" stroke="${ink}" stroke-width="9"/>`);
  if(type==='shield')return wrap(S('path',{d:'M50 12 L84 24 C84 60 70 78 50 90 C30 78 16 60 16 24 Z'}));
  if(type==='drop')return wrap(S('path',{d:'M50 12 C78 48 74 88 50 88 C26 88 22 48 50 12 Z'}));
  return wrap('');
}

/* canvas shape draw (flat, line-based) to mirror the builder */
function drawShape(ctx,type,cx,cy,r,color){
  const ink='#0c0d11',lw=Math.max(2,r*0.1);
  ctx.save();ctx.translate(cx,cy);ctx.lineJoin='round';ctx.lineCap='round';
  ctx.lineWidth=lw;ctx.strokeStyle=ink;ctx.fillStyle=color;
  const poly=(n,rot)=>{ctx.beginPath();for(let i=0;i<n;i++){const a=rot+i/n*Math.PI*2-Math.PI/2;const x=Math.cos(a)*r,y=Math.sin(a)*r;i?ctx.lineTo(x,y):ctx.moveTo(x,y);}ctx.closePath();};
  if(type==='gem'){poly(6);ctx.fill();ctx.stroke();ctx.beginPath();ctx.moveTo(-r*.5,-r*.15);ctx.lineTo(0,r*.5);ctx.lineTo(r*.5,-r*.15);ctx.stroke();}
  else if(type==='coin'){ctx.beginPath();ctx.arc(0,0,r,0,7);ctx.fill();ctx.stroke();ctx.beginPath();ctx.arc(0,0,r*.55,0,7);ctx.stroke();}
  else if(type==='heart'){ctx.beginPath();ctx.moveTo(0,r*.85);ctx.bezierCurveTo(-r*1.3,-r*.1,-r*.5,-r*1.1,0,-r*.32);ctx.bezierCurveTo(r*.5,-r*1.1,r*1.3,-r*.1,0,r*.85);ctx.fill();ctx.stroke();}
  else if(type==='star'){ctx.beginPath();for(let i=0;i<10;i++){const a=i/10*Math.PI*2-Math.PI/2;const rad=i%2?r*.42:r;ctx.lineTo(Math.cos(a)*rad,Math.sin(a)*rad);}ctx.closePath();ctx.fill();ctx.stroke();}
  else if(type==='potion'){ctx.fillStyle=ink;ctx.fillRect(-r*.28,-r*.92,r*.56,r*.22);ctx.fillStyle=color;ctx.fillRect(-r*.15,-r*.72,r*.3,r*.55);ctx.strokeRect(-r*.15,-r*.72,r*.3,r*.55);ctx.beginPath();ctx.arc(0,r*.2,r*.55,0,7);ctx.fill();ctx.stroke();}
  else if(type==='leaf'){ctx.beginPath();ctx.moveTo(0,-r);ctx.quadraticCurveTo(r*.85,-r*.1,0,r);ctx.quadraticCurveTo(-r*.85,-r*.1,0,-r);ctx.fill();ctx.stroke();ctx.beginPath();ctx.moveTo(0,-r*.6);ctx.lineTo(0,r*.6);ctx.stroke();}
  else if(type==='bolt'){ctx.beginPath();ctx.moveTo(r*.25,-r);ctx.lineTo(-r*.4,r*.1);ctx.lineTo(r*.02,r*.1);ctx.lineTo(-r*.2,r);ctx.lineTo(r*.45,-r*.2);ctx.lineTo(r*.05,-r*.2);ctx.closePath();ctx.fill();ctx.stroke();}
  else if(type==='hex'){poly(6,Math.PI/6);ctx.fill();ctx.stroke();poly(3,Math.PI/6);ctx.stroke();}
  else if(type==='badge'){poly(8);ctx.fill();ctx.stroke();ctx.beginPath();ctx.arc(0,0,r*.3,0,7);ctx.fillStyle='#fff';ctx.fill();ctx.stroke();}
  else if(type==='key'){ctx.beginPath();ctx.arc(0,-r*.4,r*.34,0,7);ctx.fill();ctx.stroke();ctx.fillRect(-r*.1,-r*.1,r*.2,r*.85);ctx.strokeRect(-r*.1,-r*.1,r*.2,r*.85);}
  else if(type==='shield'){ctx.beginPath();ctx.moveTo(0,-r);ctx.lineTo(r*.8,-r*.5);ctx.quadraticCurveTo(r*.72,r*.5,0,r);ctx.quadraticCurveTo(-r*.72,r*.5,-r*.8,-r*.5);ctx.closePath();ctx.fill();ctx.stroke();}
  else if(type==='drop'){ctx.beginPath();ctx.moveTo(0,-r);ctx.quadraticCurveTo(r*.72,r*.2,0,r*.7);ctx.quadraticCurveTo(-r*.72,r*.2,0,-r);ctx.fill();ctx.stroke();}
  ctx.restore();
}

/* build 4x3 sheet on canvas */
function renderSheet(){
  const cv=document.getElementById('pvCanvas');if(!cv)return;
  const cols=4,rows=3,tile=68,W=cols*tile,H=rows*tile;
  cv.width=W;cv.height=H;const ctx=cv.getContext('2d');
  const order=['gem','coin','heart','star','potion','leaf','bolt','hex','shield','drop','badge','key'];
  order.forEach((s,i)=>{
    const c=i%cols,r=(i/cols)|0;
    drawShape(ctx,s,c*tile+tile/2,r*tile+tile/2,tile*.3,PAL[i%PAL.length]);
  });
  ctx.save();ctx.strokeStyle='#ff5b34';ctx.lineWidth=1.4;ctx.setLineDash([tile*.07,tile*.05]);
  for(let c=1;c<cols;c++){ctx.beginPath();ctx.moveTo(c*tile,0);ctx.lineTo(c*tile,H);ctx.stroke();}
  for(let r=1;r<rows;r++){ctx.beginPath();ctx.moveTo(0,r*tile);ctx.lineTo(W,r*tile);ctx.stroke();}
  ctx.restore();
}

/* sliced cells */
function renderCells(){
  const box=document.getElementById('pvCells');if(!box)return;
  const order=['gem','coin','heart','star','potion'];
  order.forEach((s,i)=>{
    const d=document.createElement('div');d.className='pv-cell';
    d.innerHTML=svgShape(s,PAL[i%PAL.length]);
    box.appendChild(d);
  });
  const more=document.createElement('div');
  more.className='asset-more';
  more.textContent='+07';
  box.appendChild(more);
}

/* Public gallery */
(() => {
  const grid = document.getElementById('galleryGrid');
  const status = document.getElementById('galleryStatus');
  const moreButton = document.getElementById('galleryMore');
  const overlay = document.getElementById('galleryOverlay');
  const previewOverlay = document.getElementById('galleryAssetPreview');
  if (!grid || !status || !moreButton || !overlay || !previewOverlay) return;

  let offset = 0;
  let total = 0;
  let hasMore = true;
  let loading = false;
  let lastTrigger = null;
  let lastPreviewTrigger = null;

  const formatDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  function makeCard(group) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gallery-card';
    button.setAttribute('aria-label', `Buka ${group.groupName}, ${group.count} aset`);
    const preview = document.createElement('span');
    preview.className = 'gallery-card-preview';
    const image = document.createElement('img');
    image.src = group.thumbnailUrl;
    image.alt = '';
    image.loading = 'lazy';
    preview.append(image);

    const copy = document.createElement('span');
    copy.className = 'gallery-card-copy';
    const title = document.createElement('strong');
    title.textContent = group.groupName || 'Kumpulan Aset';
    const meta = document.createElement('span');
    meta.className = 'gallery-card-meta';
    const theme = document.createElement('span');
    theme.className = 'gallery-card-theme';
    theme.textContent = group.theme || 'General';
    const count = document.createElement('span');
    count.textContent = `${group.count} PNG`;
    const storage = document.createElement('span');
    storage.className = `gallery-card-storage ${group.storage === 's3' ? 'is-s3' : 'is-local'}`;
    storage.textContent = group.storage === 's3' ? 'S3' : 'LOCAL';
    storage.title = group.storage === 's3' ? 'Disimpan di cloud (S3)' : 'Disimpan di server lokal';
    meta.append(theme, count, storage);
    const open = document.createElement('span');
    open.className = 'gallery-card-open';
    const date = document.createElement('span');
    date.textContent = formatDate(group.createdAt);
    const arrow = document.createElement('b');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '↗';
    open.append(date, arrow);
    copy.append(title, meta, open);
    button.append(preview, copy);
    button.addEventListener('click', () => openGroup(group, button));
    return button;
  }

  function openGroup(group, trigger) {
    lastTrigger = trigger;
    document.getElementById('galleryModalTitle').textContent = group.groupName || 'Kumpulan Aset';
    document.getElementById('galleryModalMeta').textContent = `${group.count} aset · ${group.theme || 'General'} · ${group.style || 'general'}${formatDate(group.createdAt) ? ` · ${formatDate(group.createdAt)}` : ''}`;
    document.getElementById('galleryModalPrompt').textContent = group.prompt || 'Prompt tidak tersedia.';
    document.getElementById('galleryAssetCount').textContent = `${group.assets.length} FILE PNG`;
    const zipLink = document.getElementById('galleryZipLink');
    zipLink.href = group.exportUrl;
    const zipBaseName = (group.groupName || 'Asset Group')
      .replace(/[\u0000-\u001f\u007f\/\\:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, 100) || 'Asset Group';
    zipLink.download = `${zipBaseName}.zip`;

    const assets = document.getElementById('galleryModalAssets');
    assets.replaceChildren();
    for (const asset of group.assets) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'gallery-asset';
      link.setAttribute('aria-label', `Preview ${asset.label || asset.name}`);
      link.addEventListener('click', () => openAssetPreview(asset, link));
      const tile = document.createElement('span');
      tile.className = 'gallery-asset-preview';
      const assetImage = document.createElement('img');
      assetImage.src = asset.url;
      assetImage.alt = asset.label || asset.name;
      assetImage.loading = 'lazy';
      tile.append(assetImage);
      const name = document.createElement('span');
      name.className = 'gallery-asset-name';
      name.textContent = asset.label || asset.name;
      link.append(tile, name);
      assets.append(link);
    }
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    updateModalLock();
    document.getElementById('galleryModalClose').focus();
  }

  function closeGroup() {
    closeAssetPreview(false);
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    updateModalLock();
    lastTrigger?.focus();
  }

  function openAssetPreview(asset, trigger) {
    lastPreviewTrigger = trigger;
    const name = asset.label || asset.name;
    document.getElementById('galleryAssetPreviewTitle').textContent = name;
    document.getElementById('galleryAssetPreviewMeta').textContent = `${asset.name} · ${asset.width || '?'}×${asset.height || '?'} px`;
    const image = document.getElementById('galleryAssetPreviewImage');
    image.src = asset.url;
    image.alt = name;
    const download = document.getElementById('galleryAssetPreviewDownload');
    download.href = `${asset.url}?download=1`;
    download.download = asset.name;
    previewOverlay.classList.add('open');
    previewOverlay.setAttribute('aria-hidden', 'false');
    updateModalLock();
    document.getElementById('galleryAssetPreviewClose').focus();
  }

  function closeAssetPreview(restoreFocus = true) {
    if (!previewOverlay.classList.contains('open')) return;
    previewOverlay.classList.remove('open');
    previewOverlay.setAttribute('aria-hidden', 'true');
    document.getElementById('galleryAssetPreviewImage').removeAttribute('src');
    updateModalLock();
    if (restoreFocus) lastPreviewTrigger?.focus();
    lastPreviewTrigger = null;
  }

  document.getElementById('galleryModalClose').addEventListener('click', closeGroup);
  document.getElementById('galleryAssetPreviewClose').addEventListener('click', () => closeAssetPreview());
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeGroup();
  });
  previewOverlay.addEventListener('click', (event) => {
    if (event.target === previewOverlay) closeAssetPreview();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (previewOverlay.classList.contains('open')) closeAssetPreview();
    else if (overlay.classList.contains('open')) closeGroup();
  });

  async function loadMore() {
    if (loading || !hasMore) return;
    loading = true;
    moreButton.disabled = true;
    moreButton.textContent = 'Memuat…';
    try {
      const response = await fetch(`/api/gallery?offset=${offset}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      total = result.total;
      for (const group of result.groups) grid.append(makeCard(group));
      offset = result.nextOffset;
      hasMore = result.hasMore;
      if (total === 0) {
        status.textContent = 'Belum ada grup aset. Buat set pertama di SiberSlice Studio.';
      } else {
        status.textContent = `Menampilkan ${grid.childElementCount} dari ${total} grup aset dari semua sesi`;
      }
      moreButton.hidden = !hasMore;
    } catch {
      status.textContent = 'Galeri belum dapat dimuat. Coba lagi.';
      moreButton.hidden = false;
    } finally {
      loading = false;
      moreButton.disabled = false;
      moreButton.innerHTML = offset === 0 ? 'Coba lagi <span>↻</span>' : 'Lihat hasil lainnya <span>↓</span>';
    }
  }

  moreButton.addEventListener('click', loadMore);
  loadMore();
})();

renderSheet();renderCells();
document.getElementById('yr').textContent=new Date().getFullYear();
