# 把 godfat 的台版資料 bc-tw.yaml 轉成網站用的 data/bc-tw.json
# 只留近 120 天與之後的卡池、這些卡池裡的角色，以及全部超激與傳說（給目標搜尋用）
# 白金轉蛋標 k=plat、傳說轉蛋標 k=legend，網站用它們做白金／傳說規劃，不列進一般卡池選單
# 用法：ruby tools/build-data.rb bc-tw.yaml data/bc-tw.json
require 'yaml'
require 'json'
require 'date'

# Ruby 3.1 以後 load_file 預設不讀日期，要用 unsafe_load_file；本機 Ruby 2.6 沒有這個方法
src = YAML.respond_to?(:unsafe_load_file) ? YAML.unsafe_load_file(ARGV.fetch(0)) : YAML.load_file(ARGV.fetch(0))
cutoff = (Date.today - 120).to_s
events = {}
gacha = {}
used = {}

src['events'].each do |key, e|
  next if e['end_on'].to_s < cutoff
  cats = src['gacha'].dig(e['id'], 'cats')
  next if cats.nil? || cats.empty?
  item = { 's' => e['start_on'].to_s, 'e' => e['end_on'].to_s, 'n' => e['name'], 'id' => e['id'],
           'rare' => e['rare'], 'supa' => e['supa'], 'uber' => e['uber'] }
  item['guaranteed'] = true if e['guaranteed']
  item['step_up'] = true if e['step_up']
  item['k'] = 'plat' if e['name'].to_s.include?('白金轉蛋')
  item['k'] = 'legend' if e['name'].to_s.include?('傳說轉蛋')
  events[key] = item
  gacha[e['id']] = { 'cats' => cats }
  cats.each { |id| used[id] = true }
end

# 藍眼（貓咪祭限定超激）：出現在超激率 9% 以上的貓咪祭，
# 而一般卡池只出現在週年、新年這類「人氣角色大集合」特別池
fest = {}
regular = {}
src['events'].each_value do |e|
  next if e['name'].to_s =~ /白金轉蛋|傳說轉蛋/
  special = e['name'].to_s =~ /大集合|週年|特別|慶祝|出現率上升/
  (src['gacha'].dig(e['id'], 'cats') || []).each do |id|
    next unless src['cats'].dig(id, 'rarity') == 4
    if e['uber'].to_i >= 900 then fest[id] = true
    elsif !special then regular[id] = true
    end
  end
end

# 合作（聯名）超激：沒進過貓咪祭、白金、傳說的超激裡，說明寫「從 X 來參戰」「來自 X 系列」「在 X 中登場」的，
# 再加上跟它們同一個轉蛋池的其他限定超激（有些合作角色的說明沒寫出處，例如 EVA 的使徒）
ticket = {}
src['events'].each_value do |e|
  next unless e['name'].to_s =~ /白金轉蛋|傳說轉蛋/
  (src['gacha'].dig(e['id'], 'cats') || []).each { |id| ticket[id] = true }
end
limited = src['cats'].select { |id, c| c['rarity'] == 4 && !fest[id] && !ticket[id] }
marked = limited.select { |_, c| Array(c['desc']).first.to_s =~ /來參戰|合作|中登場|來自[^。]*?(系列|物語|！|!)/ }
collab = marked.dup
src['gacha'].each_value do |g|
  ids = g['cats'] || []
  next unless ids.any? { |id| marked[id] }
  ids.each { |id| collab[id] = true if limited[id] }
end

cats = {}
src['cats'].each do |id, c|
  next unless used[id] || c['rarity'].to_i >= 4
  cats[id] = { 'name' => c['name'], 'rarity' => c['rarity'] }
  cats[id]['blue'] = true if fest[id] && !regular[id]
  cats[id]['collab'] = true if collab[id]
end

# 內容沒變就不寫檔，避免每天只因日期不同而多一筆提交
out = ARGV.fetch(1)
body = { 'cats' => cats, 'gacha' => gacha, 'events' => events }
old = File.exist?(out) ? JSON.parse(File.read(out)).reject { |k, _| k == 'built' } : nil
if old == JSON.parse(JSON.generate(body))
  puts "沒有變化（卡池 #{events.size}、角色 #{cats.size}）"
else
  File.write(out, JSON.generate({ 'built' => Date.today.to_s }.merge(body)))
  puts "已更新（卡池 #{events.size}、角色 #{cats.size}）"
end
