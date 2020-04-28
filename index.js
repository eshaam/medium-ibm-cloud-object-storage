const express = require('express');
const fileUpload = require('express-fileupload');
const bodyParser = require('body-parser');
const _ = require('lodash');
const dotenv = require('dotenv');
dotenv.config();

const app = express();

const ibm_config = JSON.parse(process.env.IBM_CONFIG)
const ibmCOS = require('ibm-cos-sdk');
const fs = require('fs');
const async = require('async');
const cos = new ibmCOS.S3(ibm_config);

// enable files upload
app.use(fileUpload({createParentPath: true}));

//add other middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));

async function doUpload(bucketName, itemName, filePath) {
  //Taken from https://cloud.ibm.com/docs/cloud-object-storage?topic=cloud-object-storage-node
  console.log('in');
  var uploadID = null;

  if (!fs.existsSync(filePath)) {
    console.log(new Error(`The file \'${filePath}\' does not exist or is not accessible.`));
    return;
  }

  console.log(`Starting multi-part upload for ${itemName} to bucket: ${bucketName}`);
  return cos
    .createMultipartUpload({Bucket: bucketName, Key: itemName})
    .promise()
    .then((data) => {
      uploadID = data.UploadId;

      //begin the file upload
      fs.readFile(filePath, (e, fileData) => {
        //min 5MB part
        var partSize = 1024 * 1024 * 5;
        var partCount = Math.ceil(fileData.length / partSize);

        async.timesSeries(partCount, (partNum, next) => {
          var start = partNum * partSize;
          var end = Math.min(start + partSize, fileData.length);

          partNum++;

          console.log(`Uploading to ${itemName} (part ${partNum} of ${partCount})`);

          cos.uploadPart({
            Body: fileData.slice(start, end),
              Bucket: bucketName,
              Key: itemName,
              PartNumber: partNum,
              UploadId: uploadID
            })
            .promise()
            .then((data) => {
              next(e, {
                ETag: data.ETag,
                PartNumber: partNum
              });
            })
            .catch((e) => {
              cancelMultiPartUpload(bucketName, itemName, uploadID);
              console.error(`ERROR: ${e.code} - ${e.message}\n`);
            });
        }, (e, dataPacks) => {
          cos.completeMultipartUpload({
            Bucket: bucketName,
            Key: itemName,
            MultipartUpload: {
              Parts: dataPacks
            },
              UploadId: uploadID
            })
            .promise(data)
            .then((data) => {
              console.log(`Upload of all ${partCount} parts of ${itemName} successful.`)
            })
            .catch((e) => {
              console.error(`ERROR: ${e.code} - ${e.message}\n`);
            });
        });
      });
    })
    .catch((e) => {
      console.error(`ERROR: ${e.code} - ${e.message}\n`);
    });

}

app
  .post('/upload', async function (req, res) {

    try {
      if (!req.files) {
        res.send({status: false, message: 'No file uploaded'});
      } else {
        let data = [];

        //loop all files
        _.forEach(_.keysIn(req.files.objects), (key) => {
          let object = req.files.objects[key];

          //Lets generate unique file names
          let objectNameArray = object
            .name
            .split('.');
          let generatedName = `${objectNameArray[0]}-${Date.now()}.${objectNameArray[1]}`

          //Move the file to upload dir
          object.mv(process.env.UPLOAD_DIR + generatedName);

          //Create an array of files to upload
          data.push({
            name: generatedName,
            path: process.env.UPLOAD_DIR + generatedName
          });

        });

        let urls = []

        //loop through the process uplaoded files and upload
        for (const item of data) {
          let bucket = process.env.IMB_BUCKET
          let name = item.name
          let path = item.path
          await doUpload(bucket, name, path);

          //Here we need to buold the public url once its upload to ibm
          urls.push({
            url: 'https://' + ibm_config.endpoint + '/' + process.env.IMB_BUCKET + '/' + item.name
          });

        }
        console.log(urls);
        //return response with array of links to files in IBM
        res.send({status: true, message: 'Files are uploaded', data: urls});
      }
    } catch (err) {
      console.log(err);
      res
        .status(500)
        .send(err);
    }

  });

//start app
const port = process.env.PORT || 3000;

app.listen(port, () => console.log(`App is listening on port ${port}.`));
