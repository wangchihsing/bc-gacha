# 把 godfat 的台版資料 bc-tw.yaml 轉成網站用的 data/bc-tw.json
# 只留近 120 天與之後的卡池、這些卡池裡的角色，以及全部超激與傳說（給目標搜尋用）
# 用法：ruby tools/build-data.rb bc-tw.yaml data/bc-tw.json
require 'yaml'
require 'json'
require 'date'

src = YAML.load_file(ARGV.fetch(0))
cutoff = (Date.today - 120).to_s
events = {}
gacha = {}
used = {}

src['events'].each do |key, e|
  next if e['end_on'].to_s < cutoff || e['name'].to_s =~ /白金轉蛋|傳說轉蛋/
  cats = src['gacha'].dig(e['id'], 'cats')
  next if cats.nil? || cats.empty?
  item = { 's' => e['start_on'].to_s, 'e' => e['end_on'].to_s, 'n' => e['name'], 'id' => e['id'],
           'rare' => e['rare'], 'supa' => e['supa'], 'uber' => e['uber'] }
  item['guaranteed'] = true if e['guaranteed']
  item['step_up'] = true if e['step_up']
  events[key] = item
  gacha[e['id']] = { 'cats' => cats }
  cats.each { |id| used[id] = true }
end

cats = {}
src['cats'].each do |id, c|
  cats[id] = { 'name' => c['name'], 'rarity' => c['rarity'] } if used[id] || c['rarity'].to_i >= 4
end

File.write(ARGV.fetch(1), JSON.generate('built' => Date.today.to_s, 'cats' => cats, 'gacha' => gacha, 'events' => events))
puts "卡池 #{events.size}、角色 #{cats.size}"
