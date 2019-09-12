import PromiseFileReader from 'promise-file-reader'
import dicomParser from 'dicom-parser'

import "regenerator-runtime/runtime";

import DICOM_TAG_DICT from './dicomTags'

function concatenate(resultConstructor, arrays) {
  const totalLength = arrays.reduce((total, arr) => {
    return total + arr.length
  }, 0);
  const result = new resultConstructor(totalLength);
  arrays.reduce((offset, arr) => {
    result.set(arr, offset);
    return offset + arr.length;
  }, 0);
  return result;
}

class DICOMEntity {
  constructor() {
    this.metaData = {}
  }

  extractTags(metaData) {
    this.constructor.tags.forEach((tag) => {
      if (tag in metaData) {
        this.metaData[tag] = metaData[tag]
      }
    })
  }
}

class DICOMPatient extends DICOMEntity {
  static get primaryTag() {
    return 'PatientID'
  }

  static get tags() {
    return [
      'PatientID',
      'PatientName',
      'PatientBirthDate',
      'PatientSex',
      ]
    }

  constructor(metaData, file) {
    super()
    this.studies = {}
    this.extractTags(metaData)
    this.addMetaData(metaData, file)
  }

  addMetaData(metaData, file) {
    const studyId = metaData[DICOMStudy.primaryTag]
    let study = this.studies[studyId]
    if (study === undefined) {
      study = new DICOMStudy(metaData, file)
      this.studies[studyId] = study
    } else {
      study.addMetaData(metaData, file)
    }
  }
}

class DICOMStudy extends DICOMEntity {
  static get primaryTag() {
    return 'StudyID'
  }

  static get tags() {
    return [
      'StudyID',
      'StudyInstanceUID',
      'StudyDate',
      'StudyTime',
      'AccessionNumber',
      'StudyDescription',
      ]
    }

  constructor(metaData, file) {
    super()
    this.series = {}
    this.extractTags(metaData)
    this.addMetaData(metaData, file)
  }

  addMetaData(metaData, file) {
    const serieNumber = metaData[DICOMSeries.primaryTag]
    let serie = this.series[serieNumber]
    if (serie === undefined) {
      serie = new DICOMSeries(metaData, file)
      this.series[serieNumber] = serie
    } else {
      serie.addMetaData(metaData, file)
    }
  }
}

class DICOMSeries extends DICOMEntity {
  static get primaryTag() {
    return 'SeriesNumber'
  }

  static get tags() {
    return [
      'SeriesNumber',
      'SeriesInstanceUID',
      'SeriesDate',
      'SeriesTime',
      'Modality',
      'SeriesDescription',
      'ProtocolName',
      'FrameOfReferenceUID',
      ]
    }

  constructor(metaData, file) {
    super()
    this.images = {}
    this.extractTags(metaData)
    this.addMetaData(metaData, file)
    this.constructedImageData = 0
  }

  addMetaData(metaData, file) {
    const imageNumber = metaData[DICOMImage.primaryTag]
    if (imageNumber in this.images) {
      const id = metaData[DICOMSeries.primaryTag]
      throw Error(`Image ${imageNumber} already added to serie ${id}.`)
    }
    this.images[imageNumber] = new DICOMImage(metaData, file)
  }

  getImageData() {
    if (this.constructedImageData === 1) {
      console.warn(
        'DICOMSeries.getImageData was called more than once. ' +
        'Since DICOMSeries does not store the image data ' +
        '(to save memory while keeping access to its metadata), ' +
        'getImageData recomputes the image data each time it is called. ' +
        'Users of this API should cache the resulting image data ' +
        'if they need to access it again to improve performance.'
        )
    }

    function numArrayFromString(str, separator = '\\') {
      const strArray = str.split(separator)
      return strArray.map(Number)
    }

    const slices = Object.values(this.images)
    const meta = slices[0].metaData

    // Origin
    const origin = numArrayFromString(meta.ImagePositionPatient)

    // Spacing
    const spacing = numArrayFromString(meta.PixelSpacing)
    spacing.push(Number(meta.SliceThickness))

    // Dimensions
    const size = [
      meta.Rows,
      meta.Columns,
      Object.keys(this.images).length
    ]

    // Direction matrix (3x3)
    const directionCosines = numArrayFromString(meta.ImageOrientationPatient)
    const iDirCos = directionCosines.slice(0,3)
    const jDirCos = directionCosines.slice(3,6)
    const kDirCos = [
      iDirCos[1]*jDirCos[2] - iDirCos[2]*jDirCos[1],
      iDirCos[2]*jDirCos[0] - iDirCos[0]*jDirCos[2],
      iDirCos[0]*jDirCos[1] - iDirCos[1]*jDirCos[0],
    ]
    const direction = [
      iDirCos[0], jDirCos[0], kDirCos[0],
      iDirCos[1], jDirCos[1], kDirCos[1],
      iDirCos[2], jDirCos[2], kDirCos[2],
    ]

    // Image info
    const imageType = {
      // TODO: should be based on PhotometricInterpretation instead?
      // pixelType: meta.PixelRepresentation,
      components: meta.SamplesPerPixel
    }

    // Pixel data type
    const unsigned = (meta.PixelRepresentation === 0)
    const bits = meta.BitsAllocated // TODO: or stored?
    let ArrayType
    switch (bits) {
      case 8:
        ArrayType = unsigned ? Uint8Array : Int8Array
        break
      case 16:
        ArrayType = unsigned ? Uint16Array : Int16Array
        break
      case 32:
        ArrayType = unsigned ? Uint32Array : Int32Array
        break
      default:
        throw Error(`Unknown pixel bit type (${bits})`)
    }

    // Pixel data
    const pixelDataArrays = slices.map((image) => {
      const value = image.metaData.PixelData
      return new ArrayType(value.buffer, value.offset)
    })
    let data = concatenate(ArrayType, pixelDataArrays)

    // Rescale
    // TODO: ArrayType can change sign with this
    const b = Number(meta.RescaleIntercept)
    const m = Number(meta.RescaleSlope)
    const hasIntercept = !isNaN(b) && b !== 0
    const hasSlope = !isNaN(m) && m !== 1
    if (hasIntercept && hasSlope) {
      data = data.map((SV) => m * SV + b)
    } else if (hasIntercept) {
      data = data.map((SV) => SV + b)
    } else if (hasSlope) {
      data = data.map((SV) => m * SV)
    }

    this.constructedImageData = true
    return {
      imageType,
      origin,
      spacing,
      direction,
      size,
      data
    }
  }
}

class DICOMImage extends DICOMEntity {
  static get primaryTag() {
    return 'InstanceNumber'
  }

  static get tags() {
    return [
      'InstanceNumber',
      'SOPInstanceUID',
      'PatientPosition',
      'PatientOrientation',
      'ImagePositionPatient',
      'ImageOrientationPatient',
      'PixelSpacing',
      'SliceThickness',
      'SliceLocation',
      'SamplesPerPixel',
      'PlanarConfiguration',
      'PhotometricInterpretation',
      'Rows',
      'Columns',
      'BitsAllocated',
      'BitsStored',
      'HighBit',
      'PixelRepresentation',
      'PixelData',
      'RescaleIntercept',
      'RescaleSlope',
      ]
    }

  constructor(metaData, file) {
    super()
    this.file = file
    this.extractTags(metaData)
  }
}

const allTagNames = Object.values(DICOM_TAG_DICT).map((tag) => tag.name)
function checkTagsValidity(klass) {
  const name = klass.name
  const tags = klass.tags
  const primaryTag = klass.primaryTag
  if (!tags.includes(primaryTag)) {
    throw Error(`The primary tag of the ${name} class ("${primaryTag}") is not included in its list of tags ([${tags}]).`)
  }
  tags.forEach((tag) => {
    if (!allTagNames.includes(tag)) {
      throw Error(`The tag "${tag}" associated with the ${name} class is not defined in DICOM_DICTIONARY.`)
    }
  })
}
checkTagsValidity(DICOMPatient)
checkTagsValidity(DICOMStudy)
checkTagsValidity(DICOMSeries)
checkTagsValidity(DICOMImage)

class ParseDicomError extends Error {
  constructor(failures) {
    const message =
      `Failed at parsing ${failures.length} DICOM file(s). ` +
      `Find the list of files and associated errors in the ` +
      `"failures" property of the thrown error, or ignore the ` +
      `errors by calling "parseDicomFiles(fileList, true)".`
    super(message)
    this.failures = failures
  }
}

async function parseDicomFiles(fileList, ignoreFailedFiles = false) {
  const patients = {}
  const failures = []

  async function parseFile(file) {
    // Read
    const arrayBuffer = await PromiseFileReader.readAsArrayBuffer(file)

    // Parse
    const byteArray = new Uint8Array(arrayBuffer)
    const dataSet = dicomParser.parseDicom(byteArray)

    // Read metadata (recursive)
    async function readTags(dataSet) {
      const metaData = {}

      // Read value for a single tag
      async function readTag(tag) {
        const tagGroup = tag.substring(1,5)
        const tagElement = tag.substring(5,9)
        const tagKey = ("("+tagGroup+","+tagElement+")").toUpperCase();
        const tagInfo = DICOM_TAG_DICT[tagKey];
        const tagName = (tagInfo === undefined) ? tagKey : tagInfo.name
        const element = dataSet.elements[tag]

        if (element.items) {
          metaData[tagName] = []
          const readTagsOfItems = element.items.map(async (item) => {
            const itemMetaData = await readTags(item.dataSet)
            metaData[tagName].push(itemMetaData)
          })
          await Promise.all(readTagsOfItems)
          return
        }

        if (element.fragments) {
          console.warn(`${tagName} contains fragments which isn't supported`)
          return
        }

        let value = undefined

        if (tagName === 'PixelData') {
          value = {
            buffer: dataSet.byteArray.buffer,
            offset: element.dataOffset,
            length: element.length
          }
        } else {
          let vr = element.vr
          if (vr === undefined) {
            if (tagInfo === undefined || tagInfo.vr === undefined) {
              console.warn(`${tagName} vr is unknown, skipping`)
            }
            vr = tagInfo.vr
          }

          switch (vr) {
            case 'US':
              value = dataSet.uint16(tag)
              break
            case 'SS':
              value = dataSet.int16(tag)
              break
            case 'UL':
              value = dataSet.uint32(tag)
              break
            case 'US':
              value = dataSet.int32(tag)
              break
            case 'FD':
              value = dataSet.double(tag)
              break
            case 'FL':
              value = dataSet.float(tag)
              break
            case 'AT':
              value = `(${dataSet.uint16(tag, 0)},${dataSet.uint16(tag, 1)})`
              break
            case 'OB':
            case 'OW':
            case 'UN':
            case 'OF':
            case 'UT':
              // TODO: binary data? is this correct?
              if (element.length === 2) {
                value = dataSet.uint16(tag)
              } else if (element.length === 4) {
                value = dataSet.uint32(tag)
              } else {
                return
              }
              break
            default: //string
              value = dataSet.string(tag)
              break
          }
        }

        metaData[tagName] = value
      }

      // Set up promises for all tags
      const tags = Object.keys(dataSet.elements)
      const readAllTags = tags.map(readTag)

      // Read all tags
      await Promise.all(readAllTags)
      return metaData
    }
    const metaData = await readTags(dataSet)

    // Organize metadata
    const patientId = metaData[DICOMPatient.primaryTag]
    let patient = patients[patientId]
    if (patient === undefined) {
      patient = new DICOMPatient(metaData, file)
      patients[patientId] = patient
    } else {
      patient.addMetaData(metaData, file)
    }
  }

  // Set up promises
  const parseFiles = [...fileList].map((file) => {
    const promise = parseFile(file)
    return promise.catch((error) => {
      failures.push({ file, error })
    })
  })

  // Parse all files and populate patients
  const logName = `Parsed ${fileList.length} DICOM files in`
  console.time(logName)
  await Promise.all(parseFiles).then(() => {
    if (!ignoreFailedFiles && failures.length > 0) {
      throw new ParseDicomError(failures)
    }
  })
  console.timeEnd(logName)
  return { patients, failures }
}

export default parseDicomFiles