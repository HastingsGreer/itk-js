import createWebworkerPromise from './createWebworkerPromise'
import PromiseFileReader from 'promise-file-reader'

import mimeToIO from './MimeToPolyDataIO'
import getFileExtension from './getFileExtension'
import extensionToIO from './extensionToPolyDataIO'
import IOTypes from './IOTypes'

import config from './itkConfig'

const readPolyDataBlob = (webWorker, blob, fileName, mimeType) => {
  let worker = webWorker
  return createWebworkerPromise('Pipeline', worker)
    .then(({ webworkerPromise, worker: usedWorker }) => {
      worker = usedWorker
      return PromiseFileReader.readAsArrayBuffer(blob)
        .then((arrayBuffer) => {
          const extension = getFileExtension(fileName)
          let pipelinePath = null
          if (mimeToIO.has(mimeType)) {
            pipelinePath = mimeToIO.get(mimeType)
          } else if (extensionToIO.has(extension)) {
            pipelinePath = extensionToIO.get(extension)
          }
          if (pipelinePath === null) {
            Promise.reject(Error('Could not find IO for: ' + fileName))
          }

          const args = [fileName, fileName + '.output.json']
          const outputs = [
            { path: args[1], type: IOTypes.vtkPolyData }
          ]
          const inputs = [
            { path: args[0], type: IOTypes.Binary, data: new Uint8Array(arrayBuffer) }
          ]
          const transferables = []
          inputs.forEach(function (input) {
          // Binary data
            if (input.type === IOTypes.Binary) {
              if (input.data.buffer) {
                transferables.push(input.data.buffer)
              } else if (input.data.byteLength) {
                transferables.push(input.data)
              }
            }
          })
          return webworkerPromise.postMessage(
            {
              operation: 'runPolyDataIOPipeline',
              config: config,
              pipelinePath,
              args,
              outputs,
              inputs
            },
            transferables
          ).then(function ({ stdout, stderr, outputs }) {
            console.log(outputs)
            return Promise.resolve({ polyData: outputs[0].data, webWorker: worker })
          })
        })
    })
}

export default readPolyDataBlob
