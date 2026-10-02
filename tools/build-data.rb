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

cats = {}
src['cats'].each do |id, c|
  cats[id] = { 'name' => c['name'], 'rarity' => c['rarity'] } if used[id] || c['rarity'].to_i >= 4
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
