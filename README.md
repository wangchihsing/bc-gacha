# bc-gacha

貓戰（台版）抽卡規劃的手機網站：找最少抽數的抽法、抽之前預覽、看接下來的序列。

- 抽卡結果在瀏覽器裡計算，算法移植自 [battle-cats-rolls](https://gitlab.com/godfat/battle-cats-rolls)，見 `NOTICE`。
- 進度存在另一個私人儲存庫；網站本身不含任何個人資料。

## 更新卡池資料

```sh
curl -sLo /tmp/bc-tw.yaml https://gitlab.com/godfat/battle-cats-rolls/-/raw/master/build/bc-tw.yaml
ruby tools/build-data.rb /tmp/bc-tw.yaml data/bc-tw.json
```
