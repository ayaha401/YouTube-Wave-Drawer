# YouTube-Wave-Drawer

<img width="1333" height="146" alt="image" src="https://github.com/user-attachments/assets/aadf0b36-7f13-4234-884b-ed935d8cb28b" />

YouTubeの動画再生中に音声波形をリアルタイムで描画するChrome拡張

# 導入方法

1. Chromeの`拡張機能を管理`で拡張機能を設定する画面を開きます。
2. 左上の`パッケージ化されていない拡張機能を読み込む`から本データ登録します。

# 使い方

## 波形解析の出し方

<img width="1135" height="65" alt="image" src="https://github.com/user-attachments/assets/7803dc87-d9e8-447e-822a-612da93c9726" />

`波形解析`ボタンを押すことでリアルタイムでの波形解析を行うことができます。

* 10分未満の動画であること
* ショート動画でないこと

波形解析には上記の条件があります。
10分を超える動画であったりする場合は波形解析ボタンを押すことができません。

## 波形解析について

実際に再生されている位置をリアルタイムに解析します。<br>

<img width="1137" height="187" alt="image" src="https://github.com/user-attachments/assets/ef7bee4d-2afa-4ead-ba2d-7e5009f9640d" />

`全波形取得`ボタンを押すことで約16倍の速度で断続的に音声を解析し、その後途切れた部分を補間して大体の波形解析を行うことができます。

## 波形の描画画面について

再生したい場所をクリックすることでそこから再生することができます。

|色|種類|
|:---:|:---:|
|青|低音|
|オレンジ|中音|
|白|高音|

波形の色はそれぞれ音の高さで分かれています。

## HotCueとループについて

### HotCue

<img width="1184" height="175" alt="image" src="https://github.com/user-attachments/assets/f472803c-f959-4d79-b105-b0a12f546af1" />

キーボードの`1～8`を押すと再生位置に対応した数字のマーカーをつけることができます。

再度対応した数字キーを押すと即座にその位置から再生を開始します。

マーカーを消したい時はShift＋数字キーを押すことで削除できます。

### ループ

<img width="1184" height="174" alt="image" src="https://github.com/user-attachments/assets/32523556-de48-4e91-a7bc-e1dab84b5c8b" />

キーボードの`9`を押すことでループの開始位置、`0`で終了位置を設定できます。

再生位置がこの間にある間、ループをさせることができるようになります。

マーカーを消したい時は`Shift＋9` `Shift+0`を押すことで削除できます。

## Spotify検索

<img width="1127" height="57" alt="image" src="https://github.com/user-attachments/assets/bd919f6e-96e9-4add-a35b-a120be294e0d" />

一番右の`Spotify`ボタンを押すことでYoutube動画のタイトル名でSpotify検索を行います。

# 仕様

* Youtubeを初めて起動したときはデフォルトで波形解析がOffの状態で起動します。
* 波形解析をOnにした状態で次の動画に移動すると設定は引き継がれ、Onの状態になっています。

# 不具合

[Issue](https://github.com/ayaha401/YouTube-Wave-Drawer/issues)に記載されている不具合があります。

# 注意点

9.5割がClaudeCodeで作成されたコードです。
