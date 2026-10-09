/**
 * ohosTest 占位页：runner 驱动用例，本页仅满足 pages 路由要求。
 */
@Entry
@Component
struct Index {
  build() {
    Column() {
      Text('aide ohosTest')
        .fontSize(50)
        .fontWeight(FontWeight.Bold)
    }
    .width('100%')
    .height('100%')
  }
}
