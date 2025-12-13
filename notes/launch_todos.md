- for fast high performance bulk cloud uploading reserving a server with a gpu is a requirement. as such we should be an easy to use package for the archtype of an enterprise user that has a lot of data somewhere - we'll come up with a list but let's say s3, glacier, ebs, another cloud service, etc. This user would use our framework to a) spin up an appropriate aws instance with options for spot or standard and b) upload and verify the uplado into the nilstore network. we should do something like have the script accept an account address (Account A), and a private key for Account B, fund the account B with the amount needed to execute the upload job and only that amount and execute the job such that it's administrated by (account A and account B) and when the job is done they can send their funds back to account B and remove permissons for account B from the deal. theoretically if easier EIP-7702 Authorization can be used or maybe easier to just exeucte the systme directly not sure

- have the above framework work well without s3 ie on a users colocation cluster

- fast download scripts 

- fast nilstore -> s3 scripts

this is for a more at scale network but this should be a viable configuration:

This may only be moderately helpful since we haven't thought through how encryption works but i'm going to share it for note taking reasons

Upload delegations

User has lots of data and for some reason they want a third party to put it on chain. example of lots of s3 data

they create a temporary s3 key that lets the third party have access to the data (consider encryption in future iteration)

the third party has authority over a data deal from the end user
the third party uploads the data to the system
after the third party uploads if the data client want to not have to trust the third party uploader they can use our kzg commitment system to validate the data as follows:

Create a "fetch but not transfer" paid fetch where you request a fetch from the SP but you also don't actually want any of the bandwidth / data transfered to you. so for each 128kb blob/data unit they generate a KZG proof using the chain beacon randomness giving you for example k=20 inclusion proofs of 32 byte chunks. You can then fetch k=20 32 byte chunks and only those chunks from s3 and validate the proof your self.


Upside is an audit that you can run on your data.
Also upside is you can pay an SP to prove they have access to your data without you needing to download it


-- for consideration a user can pay to have the network more frequently verify their data - this would tie into the deputy/retrieval market, but give some flexibility for those with audit needs
