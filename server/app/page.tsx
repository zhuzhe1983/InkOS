import { DeviceSimulator } from "@/components/device-simulator";
import {
  CARDBOARD_SAMPLE_CONTENT,
  DETAIL_SAMPLE_CONTENT,
  EBOOK_HOME_SAMPLE_CONTENT,
  FULLSCREEN_IMAGE_CONTAIN_SAMPLE_CONTENT,
  FULLSCREEN_IMAGE_COVER_SAMPLE_CONTENT,
  GALLERY_SAMPLE_CONTENT,
  GRID_SAMPLE_CONTENT,
  IMAGE_DETAIL_SAMPLE_CONTENT,
  LIST_SAMPLE_CONTENT,
  POSTCARD_SAMPLE_CONTENT,
  READER_SAMPLE_CONTENT,
  SEMANTIC_LIST_SAMPLE_CONTENT,
} from "@/lib/rendering/sample-content";

export default function Home() {
  return (
    <DeviceSimulator
      detailDocument={JSON.stringify(DETAIL_SAMPLE_CONTENT, null, 2)}
      listDocument={JSON.stringify(LIST_SAMPLE_CONTENT, null, 2)}
      galleryDocument={JSON.stringify(GALLERY_SAMPLE_CONTENT, null, 2)}
      imageDetailDocument={JSON.stringify(IMAGE_DETAIL_SAMPLE_CONTENT, null, 2)}
      ebookHomeDocument={JSON.stringify(EBOOK_HOME_SAMPLE_CONTENT, null, 2)}
      fullscreenContainDocument={JSON.stringify(FULLSCREEN_IMAGE_CONTAIN_SAMPLE_CONTENT, null, 2)}
      fullscreenCoverDocument={JSON.stringify(FULLSCREEN_IMAGE_COVER_SAMPLE_CONTENT, null, 2)}
      gridDocument={JSON.stringify(GRID_SAMPLE_CONTENT, null, 2)}
      readerDocument={JSON.stringify(READER_SAMPLE_CONTENT, null, 2)}
      semanticListDocument={JSON.stringify(SEMANTIC_LIST_SAMPLE_CONTENT, null, 2)}
      postcardDocument={JSON.stringify(POSTCARD_SAMPLE_CONTENT, null, 2)}
      cardboardDocument={JSON.stringify(CARDBOARD_SAMPLE_CONTENT, null, 2)}
    />
  );
}
