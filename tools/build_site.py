# GitHub Pages 用のファイルを docs/ に作る
# index.html は claude.ai のページ用に <html><head> を省いて書いてあるので、ここで付ける
import shutil, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
docs = root / 'docs'
if docs.exists():
    shutil.rmtree(docs)
docs.mkdir()
src = (root / 'index.html').read_text(encoding='utf8')
cut = src.index('<div id="title">')
head, body = src[:cut], src[cut:]
page = ('<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n' + head
        + '<style>html, body { margin: 0; } img { max-width: 100%; }</style>\n</head>\n<body>\n' + body + '</body>\n</html>\n')
(docs / 'index.html').write_text(page, encoding='utf8')
for f in ['cards.js', 'game.js', 'online.js']:
    shutil.copy(root / f, docs / f)
(docs / 'cards').mkdir()
for f in (root / 'cards').glob('*.jpg'):
    shutil.copy(f, docs / 'cards' / f.name)
shutil.copytree(root / 'cards' / 'draw', docs / 'cards' / 'draw')
(docs / '.nojekyll').write_text('')
print('docs/ を作りました')
